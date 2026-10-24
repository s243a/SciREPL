// Pure, future-plan-only review packing. Importing this module performs no IO,
// claims no work, and cannot change the batching of an active campaign.

const DEFAULT_MAX_PROMPT_BYTES = 100000;
const OPTION_KEYS = new Set([
  'sections', 'measurePromptBytes', 'maxPromptBytes',
  'estimateResponseBytes', 'maxResponseBytes',
]);
const plain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'ReviewBatchingError';
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function size(value, label, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    // Never interpolate an invalid value: a callback could accidentally return
    // the private prompt itself rather than its byte count.
    fail('INVALID_REVIEW_BATCH_SIZE', `${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
  return value;
}

function total(values) {
  return values.reduce((sum, value) => size(sum + value, 'Total byte count'), 0);
}

function assertSameScope(fields) {
  const scopes = new Map();
  for (const field of fields) {
    for (const key of ['locale', 'route', 'pageRoute']) {
      if (!Object.hasOwn(field, key)) continue;
      if (typeof field[key] !== 'string' || !field[key].trim()) {
        fail('INVALID_REVIEW_BATCH_SCOPE', 'Explicit page and locale metadata must be nonempty strings');
      }
      if (scopes.has(key) && scopes.get(key) !== field[key]) {
        fail('MIXED_REVIEW_BATCH_SCOPE', 'Review packing requires fields from exactly one page and locale');
      }
      scopes.set(key, field[key]);
    }
    // Native tutorial IDs encode their page before the four-digit ordinal.
    // Generic caller IDs are also supported, but do not prove page provenance.
    const namespace = /^(.*)\.\d{4}$/.exec(field.id)?.[1];
    if (namespace !== undefined) {
      if (scopes.has('idNamespace') && scopes.get('idNamespace') !== namespace) {
        fail('MIXED_REVIEW_BATCH_SCOPE', 'Review packing cannot cross tutorial page ID namespaces');
      }
      scopes.set('idNamespace', namespace);
    }
  }
  if (scopes.has('route') && scopes.has('pageRoute') && scopes.get('route') !== scopes.get('pageRoute')) {
    fail('MIXED_REVIEW_BATCH_SCOPE', 'Review page metadata disagrees');
  }
}

/**
 * Greedily pack adjacent coherent sections from ONE page/locale into review
 * turns. The caller supplies already ordered, complete source-field objects;
 * this function never sorts, splits, removes, or rewrites them. Locale/page
 * provenance is the caller's precondition; explicit scope metadata and native
 * tutorial ID namespaces are checked when available.
 *
 * Both measurement callbacks must be pure and synchronous. measurePromptBytes
 * must count the fully serialized prompt, including draft text, contextual
 * instructions, source fields, and all protected/numeric metadata. The optional
 * response estimator must include the complete expected response envelope and
 * escaping, not merely source length. Its cap and callback must be supplied
 * together. An estimate is a planning guard, not proof of successful output.
 *
 * A callback receives a fresh frozen field array and { firstBatch: boolean }.
 * Field objects are the exact supplied objects and must be treated read-only.
 * Callback exceptions are deliberately replaced without their message/cause so
 * private prompt or draft data cannot escape through errors.
 *
 * Limits are inclusive. An indivisible section that cannot fit in its actual
 * batch context throws; none is silently accepted over a cap or dispatched.
 * This helper does not authorize a
 * call, relax review gates, or modify a pinned plan or running recovery.
 *
 * @returns {{batches: object[][], stats: object}}
 */
export function packReviewSections(options) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => !OPTION_KEYS.has(key))) {
    fail('INVALID_REVIEW_BATCH_OPTIONS', 'Expected review batching options with only documented keys');
  }
  const {
    sections, measurePromptBytes, maxPromptBytes = DEFAULT_MAX_PROMPT_BYTES,
    estimateResponseBytes, maxResponseBytes,
  } = options;
  if (!Array.isArray(sections) || typeof measurePromptBytes !== 'function') {
    fail('INVALID_REVIEW_BATCH_OPTIONS', 'Sections and a synchronous prompt byte measurer are required');
  }
  size(maxPromptBytes, 'Prompt byte cap', true);
  const hasResponseEstimate = estimateResponseBytes !== undefined;
  if (hasResponseEstimate !== (maxResponseBytes !== undefined)
      || hasResponseEstimate && typeof estimateResponseBytes !== 'function') {
    fail('INVALID_REVIEW_BATCH_OPTIONS', 'Response byte estimator and cap must be supplied together');
  }
  if (hasResponseEstimate) size(maxResponseBytes, 'Response byte cap', true);

  const ids = new Set();
  // Copy the section arrays so neither packing nor callback array operations
  // can reorder or append to the caller's original section arrays.
  const original = Array.from(sections, (section, sectionIndex) => {
    if (!Array.isArray(section) || !section.length) {
      fail('INVALID_REVIEW_BATCH_SECTION', 'Each coherent section must be a nonempty field array', { sectionIndex });
    }
    const fields = Array.from(section);
    for (const field of fields) {
      if (!plain(field) || typeof field.id !== 'string' || !field.id.trim() || typeof field.text !== 'string') {
        fail('INVALID_REVIEW_BATCH_FIELD', 'Each review field needs a nonempty ID and source text', { sectionIndex });
      }
      if (ids.has(field.id)) {
        fail('DUPLICATE_REVIEW_BATCH_FIELD', 'A review field occurs more than once', { sectionIndex });
      }
      ids.add(field.id);
    }
    return fields;
  });
  assertSameScope(original.flat());

  function measure(fields, firstBatch, sectionIndex) {
    const view = Object.freeze([...fields]);
    const context = Object.freeze({ firstBatch });
    const call = (callback, label) => {
      let result;
      try { result = callback(view, context); }
      catch {
        fail('REVIEW_BATCH_MEASUREMENT_FAILED', `${label} byte measurement failed`, { sectionIndex });
      }
      if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
        // Asynchronous measurements are invalid, but an accidentally rejected
        // promise must not later print its private error as an unhandled
        // rejection after the sanitized size check below has failed.
        try { Promise.resolve(result).then(undefined, () => {}); }
        catch { /* Invalid async values still receive only the safe size error. */ }
      }
      return size(result, `${label} byte measurement`);
    };
    const result = { promptBytes: call(measurePromptBytes, 'Prompt') };
    if (hasResponseEstimate) result.responseBytes = call(estimateResponseBytes, 'Response');
    return result;
  }
  const fits = measured => measured.promptBytes <= maxPromptBytes
    && (!hasResponseEstimate || measured.responseBytes <= maxResponseBytes);
  const assertFits = (measured, sectionIndex) => {
    if (!fits(measured)) {
      const dimension = measured.promptBytes > maxPromptBytes ? 'prompt' : 'response';
      fail('REVIEW_SECTION_OVERSIZE', 'One coherent review section exceeds its byte cap', {
        sectionIndex, dimension, measuredBytes: measured[dimension + 'Bytes'],
        maximumBytes: dimension === 'prompt' ? maxPromptBytes : maxResponseBytes,
      });
    }
  };
  const baseline = original.map((fields, sectionIndex) => measure(fields, sectionIndex === 0, sectionIndex));

  const batches = [], measurements = [];
  let current = [], currentMeasurement;
  for (let index = 0; index < original.length; index++) {
    const section = original[index];
    if (!current.length) {
      assertFits(baseline[index], index);
      current = [...section]; currentMeasurement = baseline[index];
      continue;
    }
    const candidate = [...current, ...section];
    const measured = measure(candidate, batches.length === 0, index);
    if (fits(measured)) {
      current = candidate; currentMeasurement = measured;
    } else {
      batches.push(current); measurements.push(currentMeasurement);
      assertFits(baseline[index], index);
      current = [...section]; currentMeasurement = baseline[index];
    }
  }
  if (current.length) { batches.push(current); measurements.push(currentMeasurement); }

  const beforePromptBytesBySection = baseline.map(row => row.promptBytes);
  const afterPromptBytesByBatch = measurements.map(row => row.promptBytes);
  const stats = {
    beforeCount: original.length, afterCount: batches.length,
    savedCalls: original.length - batches.length, fieldCount: ids.size,
    maxPromptBytes,
    beforePromptBytes: total(beforePromptBytesBySection),
    afterPromptBytes: total(afterPromptBytesByBatch),
    beforePromptBytesBySection, afterPromptBytesByBatch,
  };
  if (hasResponseEstimate) {
    const beforeResponseBytesBySection = baseline.map(row => row.responseBytes);
    const afterResponseBytesByBatch = measurements.map(row => row.responseBytes);
    Object.assign(stats, {
      maxResponseBytes,
      beforeResponseBytes: total(beforeResponseBytesBySection),
      afterResponseBytes: total(afterResponseBytesByBatch),
      beforeResponseBytesBySection, afterResponseBytesByBatch,
    });
  }
  return { batches, stats };
}
