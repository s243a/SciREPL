"""Lazy Matplotlib backend: Agg PNGs in the current SciREPL output card.

Selected through MPLBACKEND before the first matplotlib import. This module is
not imported by the prelude, so Python startup needs no matplotlib package.
"""

import base64
import io
import js
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas
from matplotlib.backend_bases import FigureManagerBase as FigureManager


def show(*args, **kwargs):
    """Render each open figure once, retaining SciREPL's existing PNG styling."""
    import matplotlib.pyplot as plt

    for number in plt.get_fignums():
        fig = plt.figure(number)
        with io.BytesIO() as buf:
            fig.savefig(buf, format='png', dpi=100, bbox_inches='tight',
                        facecolor='#0d1117', edgecolor='none')
            data_url = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
            js.renderImage(data_url)
    plt.close('all')
