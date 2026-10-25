// Histogram of sample variances (n=10, N(0,1)), seeded Park-Miller + Box-Muller (cos only)
let state = 42;
function nextUniform() {
  state = (16807 * state) % 2147483647;
  return state / 2147483647;
}
function nextNormal() {
  const u1 = nextUniform();
  const u2 = nextUniform();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const n = 10;
const reps = 2000;
const binCount = 40;
const binLo = 0;
const binHi = 4;
const binWidth = (binHi - binLo) / binCount;

const counts = new Array(binCount).fill(0);
let overflow = 0;
let inHist = 0;
let sumVar = 0;

for (let r = 0; r < reps; r++) {
  let mean = 0;
  const xs = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = nextNormal();
    xs[i] = x;
    mean += x;
  }
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (xs[i] - mean) * (xs[i] - mean);
  const v = ss / (n - 1);
  sumVar += v;
  const b = Math.floor((v - binLo) / binWidth);
  if (v >= binLo && v < binHi && b >= 0 && b < binCount) {
    counts[b]++;
    inHist++;
  } else {
    overflow++;
  }
}

const meanVar = sumVar / reps;
const histTotal = inHist;

// Draw canvas
const W = 900, H = 560;
const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d");

// Background
ctx.fillStyle = "#f7f7fb";
ctx.fillRect(0, 0, W, H);

// Margins
const mLeft = 80, mRight = 30, mTop = 70, mBottom = 90;
const plotW = W - mLeft - mRight;
const plotH = H - mTop - mBottom;

const maxCount = Math.max(...counts, 1);
const yMax = Math.ceil(maxCount * 1.1);

function xPix(v) { return mLeft + ((v - binLo) / (binHi - binLo)) * plotW; }
function yPix(c) { return mTop + plotH - (c / yMax) * plotH; }

// Dark text settings
ctx.textBaseline = "middle";

// Gridlines + y ticks
ctx.strokeStyle = "#dddddd";
ctx.fillStyle = "#222222";
ctx.font = "13px sans-serif";
ctx.textAlign = "right";
for (let c = 0; c <= yMax; c += Math.max(1, Math.ceil(yMax / 10))) {
  const y = yPix(c);
  ctx.beginPath();
  ctx.moveTo(mLeft, y);
  ctx.lineTo(W - mRight, y);
  ctx.stroke();
  ctx.fillText(String(c), mLeft - 8, y);
}

// Bars
const barFill = "#3b6ea5";
const barEdge = "#274d77";
for (let b = 0; b < binCount; b++) {
  const x0 = xPix(binLo + b * binWidth);
  const x1 = xPix(binLo + (b + 1) * binWidth);
  const y0 = yPix(counts[b]);
  const y1 = yPix(0);
  ctx.fillStyle = barFill;
  ctx.fillRect(x0, y0, x1 - x0 - 1, y1 - y0);
  ctx.strokeStyle = barEdge;
  ctx.strokeRect(x0, y0, x1 - x0 - 1, y1 - y0);
}

// Axes
ctx.strokeStyle = "#222222";
ctx.beginPath();
ctx.moveTo(mLeft, mTop);
ctx.lineTo(mLeft, mTop + plotH);
ctx.lineTo(W - mRight, mTop + plotH);
ctx.stroke();

// X ticks
ctx.fillStyle = "#222222";
ctx.textAlign = "center";
ctx.textBaseline = "top";
for (let v = 0; v <= 4; v += 0.5) {
  const x = xPix(v);
  ctx.beginPath();
  ctx.moveTo(x, mTop + plotH);
  ctx.lineTo(x, mTop + plotH + 5);
  ctx.strokeStyle = "#222222";
  ctx.stroke();
  ctx.fillText(v.toFixed(1), x, mTop + plotH + 8);
}

// True variance vertical line at 1
ctx.strokeStyle = "#c0392b";
ctx.lineWidth = 2;
ctx.beginPath();
ctx.moveTo(xPix(1), mTop);
ctx.lineTo(xPix(1), mTop + plotH);
ctx.stroke();
ctx.lineWidth = 1;
ctx.fillStyle = "#c0392b";
ctx.textAlign = "left";
ctx.textBaseline = "middle";
ctx.font = "13px sans-serif";
ctx.fillText("true variance = 1", xPix(1) + 6, mTop + 14);

// Axis labels and title
ctx.fillStyle = "#222222";
ctx.font = "15px sans-serif";
ctx.textAlign = "center";
ctx.textBaseline = "top";
ctx.fillText("estimated variance", mLeft + plotW / 2, H - mBottom + 34);
ctx.save();
ctx.translate(22, mTop + plotH / 2);
ctx.rotate(-Math.PI / 2);
ctx.textBaseline = "middle";
ctx.fillText("sample count", 0, 0);
ctx.restore();
ctx.font = "bold 18px sans-serif";
ctx.fillText("Histogram of estimated sample variances (n = 10, N(0,1))", W / 2, 25);

// Render
window.renderImage(canvas.toDataURL("image/png"));

// Report
"sample size=" + n +
" | repetitions=" + reps +
" | seed=42" +
" | mean estimated variance=" + meanVar.toFixed(5) +
" | histogram total=" + histTotal +
" | overflow=" + overflow;
