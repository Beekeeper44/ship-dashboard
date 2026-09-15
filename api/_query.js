// Optional: the dashboard's own SQL, run directly.
//
// Paste the query from Metabase here (question → Edit query → copy the SQL) and
// this becomes the primary route: the app runs it as a native query against
// Snowflake with the date bounds it chooses, with no dependence on a saved
// card's variables, a dashboard's filters, or anything being discoverable
// through the API. Leave it empty to keep using the saved card.
//
// Use {{start_date}} and {{end_date}} where the window belongs, e.g.
//
//   WHERE completed_at::date BETWEEN {{start_date}} AND {{end_date}}
//
// Both are replaced with validated 'YYYY-MM-DD' literals — nothing else from
// the request is ever interpolated.

export const SQL = ``;
