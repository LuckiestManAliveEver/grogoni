const buyerPrompts = ["Find me 50kg maize nearby", "Track my delivery", "Talk to a shop"];
// Same chips row, seller intents: each prompt goes to the shop agent like anything typed.
const sellerPrompts = [
  "Add a product",
  "Copy a catalogue from another shop",
  "Import my stock list",
  "Show today's sales"
];

export function HomeSuggestionChips({
  onSelect,
  seller = false
}: {
  onSelect: (prompt: string) => void;
  seller?: boolean;
}) {
  return (
    <div className="home-suggestion-chips" role="group" aria-label="Suggested requests">
      {(seller ? sellerPrompts : buyerPrompts).map((prompt) => (
        <button key={prompt} type="button" onClick={() => onSelect(prompt)}>
          {prompt}
        </button>
      ))}
    </div>
  );
}
