import { ARTIFACT_SEARCH, artifactHref, taskArtifactsHref } from './routes'

describe('artifact routes', () => {
  it('names a task’s artifacts by hub address and task id, encoded', () => {
    expect(taskArtifactsHref('hub.example:8443', 'task 1')).toBe(
      '/artifacts/hub.example%3A8443/task%201'
    )
  })

  it('names one artifact under its task, optionally one of its versions', () => {
    expect(artifactHref('hub.example', 't1', 'a1')).toBe('/artifacts/hub.example/t1/a1')
    expect(artifactHref('hub.example', 't1', 'a1', { version: 3 })).toBe(
      '/artifacts/hub.example/t1/a1?version=3'
    )
  })

  it('searches every hub at /artifacts', () => {
    expect(ARTIFACT_SEARCH).toBe('/artifacts')
  })
})
