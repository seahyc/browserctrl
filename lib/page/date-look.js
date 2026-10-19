// Before a day is clicked: how its cell looks and how many lines outside the calendar show
// the date, for date-shown to compare with.
({ selector, iso }) => {
  const { cell, lines, lookOf } = dateCheck(selector, iso);
  if (!cell) return null;
  return { look: lookOf(cell), lines: lines() };
}
