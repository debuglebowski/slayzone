/**
 * Number of component tokens each ITU T.416 extended-colour selector consumes,
 * NOT counting the selector itself.
 *
 * Handling only `5` and `2` was a real defect: selector `4` is CMYK, so
 * `ESC[38;4;10;20;30;40m` fell through to the generic token loop, where the
 * selector's own literal `4` was mistaken for SGR 4 underline and eaten — shifting
 * every component and mangling the colour. `ESC[48;4;4;4;4;4m` degenerated all the
 * way to `ESC[48m`.
 *
 *   0 — implementation-defined       (no components)
 *   1 — transparent                  (no components)
 *   2 — direct RGB                   r;g;b
 *   3 — direct CMY                   c;m;y
 *   4 — direct CMYK                  c;m;y;k
 *   5 — indexed                      idx
 */
const COLOR_SELECTOR_COMPONENTS: Record<string, number> = {
  '0': 0,
  '1': 0,
  '2': 3,
  '3': 3,
  '4': 4,
  '5': 1
}

/**
 * Strip SGR 4 (underline) codes from terminal data.
 * Handles all variants: SGR 4, 4:1-4:5 (single, double, curly, dotted, dashed).
 *
 * SGR-structure aware: `38`/`48`/`58` (extended fg/bg/underline color) consume the
 * tokens that follow as a color spec, per {@link COLOR_SELECTOR_COMPONENTS}. A `4`
 * appearing as a colour selector, index, or component is NOT underline and must be
 * preserved. The walk skips a color spec verbatim instead of filtering its tokens.
 * Colon sub-parameter form (`38:5:4`, `4:3`) is already a single `;`-token, so it is
 * handled by the per-token checks without special-casing.
 */
export function stripUnderlineCodes(data: string): string {
  return data.replace(/\x1b\[([0-9;:]*)m/g, (_, params) => {
    if (!params) return '\x1b[m'
    const tokens: string[] = params.split(';')
    const kept: string[] = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      // Extended color introducer — keep it and copy its color spec untouched.
      if (tok === '38' || tok === '48' || tok === '58') {
        kept.push(tok)
        const selector = tokens[i + 1]
        const components = selector === undefined ? undefined : COLOR_SELECTOR_COMPONENTS[selector]
        if (components !== undefined) {
          // Copy the selector plus its components verbatim — none of them is SGR.
          const span = components + 1
          for (let j = 1; j <= span && i + j < tokens.length; j++) kept.push(tokens[i + j])
          i += span
        }
        // Unknown/missing selector → just keep the introducer, continue normally.
        continue
      }
      // Real SGR underline: standalone `4` or sub-parameter form `4:<n>`.
      if (tok === '4' || tok.startsWith('4:')) continue
      // Everything else (including empty tokens from `;;`) passes through.
      kept.push(tok)
    }
    // Emit whenever any token survived, even if they all joined to an EMPTY
    // string. `ESC[;4m` is "reset, then underline" — the empty first parameter
    // defaults to 0 — so dropping the `4` leaves `kept = ['']`, which joins to
    // `''`. Testing the joined string for truthiness deleted the whole sequence
    // and with it the implicit reset, letting the previous colour/bold bleed into
    // the following text. `ESC[m` (bare = reset) is the correct remainder.
    // Only a genuinely empty `kept` (e.g. a bare `ESC[4m`) strips to nothing.
    if (kept.length === 0) return ''
    return `\x1b[${kept.join(';')}m`
  })
}
