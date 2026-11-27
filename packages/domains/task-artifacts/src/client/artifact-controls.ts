import {
  ARTIFACT_CONTROLS_TAG,
  artifactControlsPositions,
  type ArtifactControlsPosition
} from '@slayzone/platform/artifact-controls'

/** The dock positions an HTML artifact's `<slay-artifact-controls>` use, in dock order. */
export function parseArtifactControls(html: string): ArtifactControlsPosition[] {
  if (!html.toLowerCase().includes(ARTIFACT_CONTROLS_TAG)) return []
  // Only read markup in the renderer. Authored UI runs in sandboxed frames.
  const template = document.createElement('template')
  template.innerHTML = html
  const elements = template.content.querySelectorAll(ARTIFACT_CONTROLS_TAG)
  return artifactControlsPositions([...elements].map((el) => el.getAttribute('position')))
}
