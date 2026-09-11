/** The word a user types to confirm clearing all Orbit data.
 *
 *  Shared so the panel that asks for it and the main process that checks it
 *  can never disagree — the confirmation is part of the operation, not a
 *  label on a dialog.
 */
export const CLEAR_DATA_CONFIRMATION = 'CLEAR'
