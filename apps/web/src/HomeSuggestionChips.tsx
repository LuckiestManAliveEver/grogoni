export function HomeSuggestionChips({ onSelect }: { onSelect: (prompt: string) => void }) {
  return (
    <div className="home-suggestion-chips" role="group" aria-label="Suggested requests">
      {["Find me 50kg maize nearby", "Track my delivery", "Talk to a shop"].map((prompt) => (
        <button key={prompt} type="button" onClick={() => onSelect(prompt)}>
          {prompt}
        </button>
      ))}
    </div>
  );
}
