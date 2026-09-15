// The Ship Dashboard query, run directly against Snowflake.
//
// This is question 38974's SQL with Metabase's optional `[[ … ]]` blocks
// resolved — that syntax is Metabase's, not Snowflake's, so it can't survive
// outside a saved card. The two date bounds stay as {{start_date}} and
// {{end_date}} and are replaced with validated 'YYYY-MM-DD' literals by
// api/shipments.js. Nothing else from the request is ever interpolated.
//
// The card's other optional filters (employee, order number, tracking number,
// carrier, min/max cards) are deliberately left out: the dashboard already
// applies those in the browser against the rows it has.
//
// Set this to an empty string to fall back to querying the saved card.

export const SQL = `
WITH ship_events AS (
  SELECT ol.CARD_ID, ol.USER_ID, ol.FINISHED_AT
  FROM (SELECT * FROM APP_PROD.ADMIN.OPERATION_LOGS
        WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) ol
  WHERE ol.KIND = 'ship_card'
    AND ol.CARD_ID IS NOT NULL
    AND ol.FINISHED_AT >= DATEADD(day, -3, TO_DATE({{start_date}}))
    AND ol.FINISHED_AT <  DATEADD(day,  2, TO_DATE({{end_date}}))
),

card_orders AS (
  SELECT ID AS CARD_ID, ORDER_ID FROM (SELECT * FROM APP_PROD.ADMIN.CARDS
    WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) WHERE ORDER_ID IS NOT NULL
  UNION
  SELECT ID, RETURN_ORDER_ID FROM (SELECT * FROM APP_PROD.ADMIN.CARDS
    WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) WHERE RETURN_ORDER_ID IS NOT NULL
),

shipped_orders AS (
  SELECT
    po.ID, po.NUMBER,
    COALESCE(po.RETURN_SHIPMENT_TRACKING_NUMBER, po.SEND_SHIPMENT_TRACKING_NUMBER) AS TRACKING_NUMBER,
    COALESCE(po.RETURN_SHIPMENT_TRACKING_URL,    po.SEND_SHIPMENT_TRACKING_URL)    AS TRACKING_URL,
    COALESCE(po.RETURN_SHIPPING_LABEL_URL,       po.SEND_SHIPPING_LABEL_URL)       AS LABEL_URL
  FROM (SELECT * FROM APP_PROD.ADMIN.ORDERS  WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) ao
  JOIN (SELECT * FROM APP_PROD.PUBLIC.ORDERS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) po
    ON po.ID = ao.ID
  WHERE LOWER(ao.STATUS) = 'shipped'
),

name_overrides AS (
  SELECT * FROM VALUES
    ('15c43202-3b17-4a8c-9316-a601328c92ee', 'Jimi Kim')
    AS t(USER_ID, FULL_NAME)
),

resolved AS (
  SELECT se.CARD_ID, se.USER_ID, se.FINISHED_AT,
         so.ID AS SHIP_ORDER_ID, so.NUMBER AS ORDER_NUMBER,
         so.TRACKING_NUMBER, so.TRACKING_URL, so.LABEL_URL
  FROM ship_events se
  JOIN card_orders co    ON co.CARD_ID = se.CARD_ID
  JOIN shipped_orders so ON so.ID = co.ORDER_ID
  QUALIFY ROW_NUMBER() OVER (PARTITION BY se.CARD_ID, se.FINISHED_AT
                             ORDER BY so.TRACKING_NUMBER NULLS LAST) = 1
),

per_order AS (
  SELECT SHIP_ORDER_ID,
         ANY_VALUE(ORDER_NUMBER)      AS ORDER_NUMBER,
         ANY_VALUE(TRACKING_NUMBER)   AS TRACKING_NUMBER,
         ANY_VALUE(TRACKING_URL)      AS TRACKING_URL,
         ANY_VALUE(LABEL_URL)         AS LABEL_URL,
         COUNT(DISTINCT CARD_ID)      AS CARDS_SHIPPED,
         MAX(FINISHED_AT)             AS COMPLETED_AT_UTC,
         MAX_BY(USER_ID, FINISHED_AT) AS SHIPPED_BY_USER_ID
  FROM resolved GROUP BY SHIP_ORDER_ID
),

joined AS (
  SELECT po.SHIP_ORDER_ID, po.ORDER_NUMBER, po.CARDS_SHIPPED,
         po.TRACKING_NUMBER, po.TRACKING_URL, po.LABEL_URL,
         po.SHIPPED_BY_USER_ID,
         CONVERT_TIMEZONE('America/Los_Angeles', po.COMPLETED_AT_UTC) AS COMPLETED_AT,
         COALESCE(NULLIF(TRIM(u.FIRST_NAME || ' ' || u.LAST_NAME), ''), u.EMAIL, n.FULL_NAME,
                  'Unmapped user ' || po.SHIPPED_BY_USER_ID) AS SHIPPED_BY,
         UPPER(REGEXP_REPLACE(COALESCE(po.TRACKING_NUMBER,''), '[^A-Za-z0-9]', '')) AS T
  FROM per_order po
  LEFT JOIN (SELECT * FROM APP_PROD.PUBLIC.USERS
             WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)) u ON u.ID = po.SHIPPED_BY_USER_ID
  LEFT JOIN name_overrides n ON n.USER_ID = po.SHIPPED_BY_USER_ID
),

final AS (
  SELECT SHIPPED_BY, ORDER_NUMBER, CARDS_SHIPPED, TRACKING_NUMBER,
    CASE
      WHEN T IS NULL OR T = ''                          THEN 'No tracking'
      WHEN LEFT(T, 2) = '1Z'                            THEN 'UPS'
      WHEN LEFT(T, 4) = 'JJD0'                          THEN 'DHL'
      WHEN LEFT(T, 3) = '963'                           THEN 'FedEx Ground'
      WHEN LEFT(T, 2) = '87' AND LENGTH(T) = 12         THEN 'FedEx — unverified'
      WHEN LEFT(T, 2) IN ('92','93','94','95')
           AND LENGTH(T) BETWEEN 20 AND 26              THEN 'USPS'
      WHEN LEFT(T, 3) = '420'                           THEN 'USPS'
      WHEN LEFT(T, 2) IN ('10','11','12','13','33')     THEN 'FedEx Express'
      ELSE 'Unknown — check'
    END AS CARRIER,
    COMPLETED_AT,
    'https://admin.arenaclub.com/orders/' || SHIP_ORDER_ID AS ORDER_URL,
    TRACKING_URL,
    LABEL_URL,
    REPLACE(LABEL_URL, 'format=pdf_4_x_6', 'format=png_4_x_6') AS LABEL_IMAGE,
    SHIP_ORDER_ID,
    SHIPPED_BY_USER_ID
  FROM joined
)

SELECT *
FROM final
WHERE COMPLETED_AT >= TO_DATE({{start_date}})
  AND COMPLETED_AT <  DATEADD(day, 1, TO_DATE({{end_date}}))
ORDER BY COMPLETED_AT DESC
`;
