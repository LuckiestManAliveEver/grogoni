# Shop system API

The shop system API connects an existing commerce or ERP system to a Grogoni shop. Create a
shop-bound connection under **Agent settings → Shop API**, copy the secret when it is shown, and
send it as an HTTP bearer token. Tokens are stored as hashes, expire after 30 days, and can be
revoked from the same screen.

## Permissions

- `mcp:read` allows the system to read incoming orders for the bound shop.
- `mcp:act` allows catalogue synchronization and order-status updates. Creating an action-capable
  token requires the owner's PIN.

The token cannot access another shop. Customer checkout still goes through Grogoni Chat's explicit
confirmation gate before an order becomes visible to the connected system.

These endpoints are classified as interactive and carry a 150 ms server-response budget. Responses
include `Server-Timing`, `X-Grogoni-Response-Budget-Class`, and `X-Grogoni-Response-Budget-Ms` headers;
production logs emit `http.response_budget_exceeded` whenever the server misses that budget.

## Synchronize catalogue

`PUT /v1/shop-system/catalogue`

```json
{
  "products": [
    {
      "sku": "FLOUR-2KG",
      "name": "Maize flour 2kg",
      "unit": "bag",
      "quantity": 20,
      "sellingPrice": 240,
      "aliases": ["unga"]
    }
  ]
}
```

Products are upserted by SKU within the token's shop. A request can contain at most 1,000
products. `quantity` must be a non-negative integer and `sellingPrice` may be a non-negative
number or `null`.

## Read and update orders

`GET /v1/shop-system/orders` returns orders created by confirmed Grogoni Chat checkouts for the bound
shop, newest first.

`PATCH /v1/shop-system/orders/{orderId}` accepts one of these statuses:

```json
{ "status": "accepted" }
```

Supported values are `accepted`, `rejected`, `completed`, and `cancelled`.
