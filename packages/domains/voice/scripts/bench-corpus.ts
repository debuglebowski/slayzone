/**
 * "Normal technical talk" for the keyword bench: what someone says to a coding
 * agent. Some sentences use "over" the ordinary way — mid-sentence, inside
 * words, and (rarely, as in real speech) as the last word of a sentence.
 */

export const TALK: readonly string[] = [
  'Open the task board and look at the login bug.',
  'I think the problem is in the session refresh logic.',
  'Can you check why the integration tests are flaky on main?',
  'The build has been red since yesterday afternoon.',
  'Let us start with the database migration.',
  'Rename the helper to something more descriptive.',
  'Actually, keep the old name for now and add a comment.',
  'The API returns a four oh four when the token is expired.',
  'We should return a four oh one instead.',
  'Make sure the retry logic does not hammer the server.',
  'Use exponential backoff with a cap of thirty seconds.',
  'Then write a unit test for the edge case with an empty list.',
  'I am not sure about the naming yet.',
  'What does the current implementation do when the cache is cold?',
  'The settings page takes almost two seconds to render.',
  'Profile it and tell me which component is slow.',
  'My guess is the dropdown that loads every project.',
  'Split the query so the first page loads immediately.',
  'Add a loading skeleton while the rest comes in.',
  'Check the diff before you commit anything.',
  'Do not touch the generated files.',
  'The linter complains about unused imports in three files.',
  'Fix those and run the full type check.',
  'If the type check passes, push the branch.',
  'Open a pull request with a short description.',
  'Mention that it fixes the flaky test.',
  'Hmm, let me think about this for a second.',
  'Okay, so the websocket reconnects too aggressively.',
  'It should wait until the network is back.',
  'There is an online event in the browser for that.',
  'Can we use that instead of polling every second?',
  'Also log a warning when the reconnect fails three times.',
  'The memory usage keeps growing during long sessions.',
  'Take a heap snapshot after ten minutes of use.',
  'Look for detached nodes and event listeners that never get removed.',
  'I suspect the terminal component leaks its resize observer.',
  'Write the summary as a short list of findings.',
  'Keep it brief, I will read the details later.',
  'Next, the dark theme has a contrast problem in the sidebar.',
  'The muted text is almost invisible on the darker surface.',
  'Use the theme tokens rather than raw colors.',
  'Run the visual tests afterwards.',
  'How long does the end to end suite take right now?',
  'Can we shard it across more workers?',
  'No, the box is already saturated at six workers.',
  'Then let us find the slowest specs instead.',
  'Sort them by duration and show me the top ten.',
  'The second one looks suspicious.',
  'Why does it wait for a fixed timeout?',
  'Replace the timeout with a proper wait for the element.',
  // "over", the ordinary way.
  'Let us go over the failing tests one by one.',
  'The overall structure looks fine to me.',
  'We should override the default timeout in that test.',
  'The hover state on the button is broken.',
  'The log file rolled over at midnight and we lost the first entries.',
  'Move the handler over to the shared package.',
  'I have gone back and forth on this all morning.',
  'Copy the config over from the staging environment.',
  'The migration is finally over.',
  'Hand the ticket over.',
  'If it fails again we start over.',
  'Look it over.'
]

/** Sentences above whose last word is a natural "over" (worst case for the keyword). */
export const NATURAL_FINAL_OVER = new Set([
  'The migration is finally over.',
  'Hand the ticket over.',
  'If it fails again we start over.',
  'Look it over.'
])

/** How the user ends a turn with the keyword. */
export const KEYWORD_ENDINGS: ReadonlyArray<(last: string) => string[]> = [
  // "..., over." on the same breath
  (last) => [`${last.replace(/[.?!]$/, '')}, over.`],
  // "... . Over." as its own sentence
  (last) => [`${last} Over.`],
  // the last sentence, a short pause, then "Over." alone
  (last) => [last, 'Over.']
]
