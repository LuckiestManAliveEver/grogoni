# Assistant and model permissions

My Assistant details contains an action checklist and the complete executable-tool catalogue,
grouped by the permission each function requires. Read and Edit are enabled initially. Create,
Delete, Send/publish, Buy/order, Record payments, Run actions, and Store setup are disabled.

The settings apply to the account's assistant and selected model, independently of engine/model
selection. They are saved in the existing account agent's JSON configuration and survive snapshot
reload and runtime selection changes; no new database schema is required. Only the owning account
can read or update `/v1/conversations/:conversationId/permissions`, for its permanent assistant
conversation. Updates are audited. Unknown actions are rejected and new unclassified tools fail closed.

The runtime filters model tool lists and checks permissions again at proposal and confirmation.
Disabling Read also withholds automatically retrieved business context and saved correction memory
from the model; the current message and conversation remain available for a reply.
The buyer assistant also checks at dispatch and at checkout confirmation. These permissions do
not change actions performed directly by the human user, business-role access, OS permissions,
tool confirmations, or any prerequisite for a capability. Store access remains forbidden for
guests even if a mutation permission is enabled. Store setup is currently a human-only operation;
granting its assistant permission does not manufacture a store-creation tool.

Guest sessions retain their device identity and can browse, buy, chat, and use personal functions.
Store creation and business-scoped authenticated APIs reject guest sessions with
`store_account_required`. The frontend routes a guest's deliberate store-setup request to signup.
There is no automatic passkey-enrollment prompt on the main app screen.
