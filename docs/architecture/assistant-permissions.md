# Assistant and model permissions

My Assistant details contains an action checklist and the complete executable-tool catalogue,
grouped by the permission each function requires. Every action starts enabled, and stays enabled
until the account owner turns it off. Saves made before version 2 wrote every old default, so their
off values for anything but Read and Edit are ignored; each new save records the version.

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
tool confirmations, or any prerequisite for a capability. The Store setup action covers the
assistant's store tools, which also need ordinary business membership.

Guest sessions can browse, buy, chat and register a shop, from the menu or by asking the marketplace
agent (`apps/web/src/shop-registration-chat.ts`). The guest's own account becomes the owner. The
agent asks for the name and phone, then needs an explicit yes, because a shop is permanent and an
account owns one. Turning off Set up a store stops the agent's route (`viaAssistant` on
`POST /businesses`), not the Set up your shop button.
There is no automatic passkey-enrollment prompt on the main app screen.
