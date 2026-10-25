# Permanent Help chat

Every signed-in account gets a permanent **Help** chat and six separate sub-chats: Buying, Selling, Receipts and documents, Messaging, Tools, and Account and troubleshooting. Help stays above ordinary conversations and remains visible while searching. Its threads cannot be renamed, archived, unpinned, or deleted. Ordinary chat controls are unchanged.

Each thread starts with a guide. The Tools guide is generated from the canonical hashtag capability registry so every registered tool is represented. Users can ask follow-up questions in any thread. Questions and Luna's replies use the existing account conversation storage and daemon, so history survives reloads and stays private to that account. Help explains commands; it does not dispatch them to shop tools or external channels. Actual operations belong in the user's ordinary shop chat and retain their normal confirmation requirements.

Initialization uses the authenticated, idempotent `POST /v1/help` endpoint. Stable account-scoped conversation IDs and versioned guide message IDs prevent duplicate threads and seeds. Help metadata is stored in the existing conversation JSON records; no schema migration is needed. Existing default buyer sessions exclude Help when selecting the account's ordinary personal conversation. Help setup failures do not prevent the ordinary inbox from loading.

Temporary device accounts can run the browser daemon while a Help thread is open, so assistance does not require signing up first. Existing sign-in requirements for other features are unchanged.

Luna needs the same configured model and daemon capabilities as existing background chat assistance. Help prompts include the selected guide, recent thread history, and the user's full question within the daemon's message budget. The agent is instructed to identify uncertainty and cannot inspect private shop records or claim to execute actions.
