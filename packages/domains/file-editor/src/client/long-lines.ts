/** Whether any line of `text` is longer than `max` chars (a CR before the LF counts with its line). */
export function hasLineLongerThan(text: string, max: number): boolean {
  let start = 0
  for (;;) {
    const end = text.indexOf('\n', start)
    if ((end === -1 ? text.length : end) - start > max) return true
    if (end === -1) return false
    start = end + 1
  }
}
