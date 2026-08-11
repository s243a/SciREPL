/**
 * bridge.js — Rendering bridge between Pyodide (Python) and the app UI.
 * Exposes global functions that Python calls via js.functionName().
 */

/* ---- Plot rendering (Plotly.js) ---- */

window.renderPlot = function (jsonStr) {
    const data = JSON.parse(jsonStr);
    const container = window._currentOutputCard;
    if (!container) return;

    const plotDiv = document.createElement('div');
    plotDiv.className = 'plot-container';
    container.querySelector('.card-body').appendChild(plotDiv);

    const traces = data.traces || (() => {
        const trace = {
            y: data.y,
            type: data.type || 'scatter',
            mode: data.mode || 'lines',
            name: data.name || ''
        };
        if (data.x) trace.x = data.x;
        if (data.line) trace.line = data.line;
        if (data.marker) trace.marker = data.marker;
        return [trace];
    })();

    const baseLayout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: '#161b22',
        font: { color: '#e6edf3', family: '-apple-system, sans-serif', size: 12 },
        margin: { t: 30, r: 20, b: 40, l: 50 },
        xaxis: {
            gridcolor: '#30363d',
            zerolinecolor: '#484f58',
            title: data.xlabel || ''
        },
        yaxis: {
            gridcolor: '#30363d',
            zerolinecolor: '#484f58',
            title: data.ylabel || ''
        },
        title: data.title || '',
        showlegend: traces.length > 1
    };
    // Deep merge user layout so nested keys (yaxis.scaleanchor) don't clobber defaults
    const userLayout = data.layout || {};
    const layout = baseLayout;
    for (const [k, v] of Object.entries(userLayout)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && layout[k] && typeof layout[k] === 'object') {
            Object.assign(layout[k], v);
        } else {
            layout[k] = v;
        }
    }

    const config = {
        responsive: true,
        displayModeBar: false,
        scrollZoom: true
    };

    Plotly.newPlot(plotDiv, traces, layout, config);
};

/* ---- LaTeX rendering (KaTeX) ---- */

window.renderLatex = function (texStr) {
    const container = window._currentOutputCard;
    if (!container) return;

    const latexDiv = document.createElement('div');
    latexDiv.className = 'latex-result';
    container.querySelector('.card-body').appendChild(latexDiv);

    latexDiv.dataset.tex = texStr;
    try {
        katex.render(texStr, latexDiv, {
            throwOnError: false,
            displayMode: true,
            output: 'htmlAndMathml'
        });
    } catch (e) {
        latexDiv.textContent = texStr;
    }
};

/* ---- Table rendering ---- */

window.renderTable = function (jsonStr) {
    const data = JSON.parse(jsonStr);
    const container = window._currentOutputCard;
    if (!container) return;

    const table = document.createElement('table');
    const body = container.querySelector('.card-body');

    // Header row (if provided)
    if (data.headers) {
        const thead = document.createElement('thead');
        const tr = document.createElement('tr');
        data.headers.forEach(h => {
            const th = document.createElement('th');
            th.textContent = h;
            tr.appendChild(th);
        });
        thead.appendChild(tr);
        table.appendChild(thead);
    }

    // Data rows
    const tbody = document.createElement('tbody');
    (data.rows || []).forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
            const td = document.createElement('td');
            td.textContent = typeof cell === 'number' ? (Number.isInteger(cell) ? cell : cell.toPrecision(6)) : cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
};

/* ---- Inline image rendering (matplotlib, R plots) ---- */

window.renderImage = function (dataUrl) {
    const container = window._currentOutputCard;
    if (!container) return;

    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.maxWidth = '100%';
    img.style.borderRadius = '6px';
    img.style.marginTop = '8px';
    container.querySelector('.card-body').appendChild(img);
};

/* ---- Text output ---- */

window.renderText = function (text, isError) {
    const container = window._currentOutputCard;
    if (!container) return;

    if (isError) {
        container.classList.add('card-error');
    }

    const pre = document.createElement('pre');
    pre.className = isError ? 'error-result' : 'text-result';
    pre.dir = 'ltr';
    pre.textContent = text;
    container.querySelector('.card-body').appendChild(pre);
};
