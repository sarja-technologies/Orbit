/** Provider marks are committed SVG files (see assets/providers/SOURCES.md)
 *  and inlined at build time by Vite's `?raw` import. Orbit never fetches a
 *  logo at runtime — the renderer's CSP would refuse it, and an offline app
 *  must still draw.
 *
 *  This declaration lives in its own file on purpose: an ambient module
 *  declaration is only ambient in a .d.ts with no top-level import/export,
 *  and global.d.ts has both. */
declare module '*.svg?raw' {
  const content: string
  export default content
}
