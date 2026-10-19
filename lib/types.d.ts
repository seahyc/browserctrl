// Shapes that cross module boundaries, for `npm run typecheck` (JSDoc in the .mjs files
// refers to these with import('./types.js').Name). Nothing here exists at run time.

/** One control in a page snapshot (refs.mjs), as grounding, Jev and the commit guard see it. */
export interface SnapElement {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  testid?: string;
  near?: string;
  within?: string;
  checked?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  inert?: boolean;
  covered?: string | boolean;
  coverPinned?: boolean;
  offscreen?: string;
  focused?: boolean;
  new?: boolean;
  /** A form's submit button. */
  submit?: boolean;
  /** Inside a search or filter area. */
  infilter?: boolean;
  /** Named from the row it sits in, not by the page. */
  borrowed?: boolean;
  derived?: boolean;
  nameFrom?: string;
}

/** What the commit guard knows about the moment of the click. */
export interface CommitContext {
  /** The plan just typed into a search-like field. */
  afterSearchFill?: boolean;
  /** The page shows payment fields or a payment provider's frame. */
  checkout?: boolean;
  /** The page's lang attribute. */
  lang?: string;
}

/** A Jev question (TypeSafe System One). */
export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, unknown> }
  | { type: 'noul'; instructions: string };

/** A Jev answer to a choice question. */
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** An item of a list, as items.mjs returns it. */
export interface ListItem {
  id: string;
  text?: string;
  link?: string;
}

/** A line of page text offered to extract. */
export interface Span {
  text: string;
  i?: number;
}

/** Where browserctrl keeps things (config.mjs). */
export interface Dirs {
  data: string;
  config: string;
  state: string;
  runtime: string;
}
