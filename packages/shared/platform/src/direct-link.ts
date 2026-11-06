/**
 * Direct client ↔ computer link facts shared by the desktop's main process and its
 * clients (docs/direct-link.md).
 *
 * @module platform/direct-link
 */

/**
 * The hub id a direct link names outside any hub scope (a single-hub client): the
 * desktop's main process reads it as the registry's default hub.
 */
export const DIRECT_LINK_DEFAULT_HUB_ID = 'default'
