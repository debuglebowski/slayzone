/**
 * Mock for @dagrejs/dagre — handler tests don't use graph layout.
 */
export default {
  graphlib: { Graph: class {} },
  layout: () => {}
}
