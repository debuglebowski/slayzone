/**
 * Drawing mermaid diagrams inside an artifact page, with desktop's renderer: the same
 * mermaid build (bundled into the app, `page-assets.ts`) and options
 * (`mermaidInitOptions`: strict security, dagre layout, the app's light/dark theme).
 *
 * The page holds each diagram as a `.mermaid-block`: its source as an escaped
 * `<pre><code>` (what shows while drawing, and if mermaid can't parse it — desktop shows
 * the code then too), an empty `.mermaid-diagram`, and a Preview / Raw toggle (desktop's
 * editor has the same per diagram). The page script draws the blocks one after another.
 */
import { mermaidInitOptions } from '@slayzone/markdown/mermaid-config'
import { escapeHtml, inlineScript, type PageTheme } from './page-style'

/** A diagram's block; `fill` = the whole page is this one diagram (a `.mmd` artifact). */
export function mermaidBlock(source: string, options: { fill: boolean }): string {
  return [
    `<div class="mermaid-block${options.fill ? ' mermaid-fill' : ''}" data-view="loading">`,
    options.fill
      ? ''
      : '<div class="mermaid-toolbar"><button type="button" data-show="diagram">Preview</button><button type="button" data-show="source">Raw</button></div>',
    '<div class="mermaid-diagram"></div>',
    `<pre class="mermaid-source"><code class="language-mermaid">${escapeHtml(source)}</code></pre>`,
    '</div>'
  ].join('')
}

/** The two scripts a page with diagrams carries: mermaid itself, then the drawing. */
export function mermaidScripts(nonce: string, mermaidScript: string, theme: PageTheme): string {
  const options = JSON.stringify(mermaidInitOptions(theme.variant))
  const draw = `(function () {
  mermaid.initialize(${options});
  var blocks = Array.prototype.slice.call(document.querySelectorAll('.mermaid-block'));
  var n = 0;
  blocks.reduce(function (previous, block) {
    return previous.then(function () {
      var code = block.querySelector('.mermaid-source code');
      var host = block.querySelector('.mermaid-diagram');
      var source = (code ? code.textContent : '').replace(/\\n$/, '');
      n += 1;
      return mermaid.render('slz-mermaid-' + n, source).then(function (result) {
        host.innerHTML = result.svg;
        var svg = host.querySelector('svg');
        if (svg) {
          svg.style.backgroundColor = 'transparent';
          svg.style.maxWidth = '100%';
          svg.removeAttribute('height');
        }
        block.setAttribute('data-view', 'diagram');
      }, function () {
        block.setAttribute('data-view', 'error');
      });
    });
  }, Promise.resolve());
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-show]') : null;
    if (!button) return;
    var block = button.closest('.mermaid-block');
    var view = block && block.getAttribute('data-view');
    if (view === 'diagram' || view === 'source') block.setAttribute('data-view', button.getAttribute('data-show'));
  });
})();`
  return inlineScript(nonce, mermaidScript) + inlineScript(nonce, draw)
}
