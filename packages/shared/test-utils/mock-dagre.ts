/**
 * Mock for @dagrejs/dagre — handler tests don't use graph layout.
 */
export default {
  graphlib: { Graph: class {} },
  layout: () => {
    // The real layout mutates the graph in place. No handler test reads the
    // resulting node positions — only that importing dagre does not blow up.
  }
}
