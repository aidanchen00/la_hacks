from pathlib import Path
from agents.shopping.base import make_seller_agent

walgreens = make_seller_agent(
    name="walgreens",
    port=8104,
    seed="walgreens-seller-seed-la-hacks-2026",
    platform="Walgreens",
    readme_path=str(Path(__file__).parent / "README_walgreens.md"),
    browser_task_template=(
        'Go to walgreens.com and search for "{query}". '
        "Find the best OTC product that costs under ${budget:.2f}. "
        "Return ONLY a JSON object with keys: "
        "name (string), price (number), url (string), description (string), in_stock (boolean). "
        "Example: {{\"name\": \"NyQuil\", \"price\": 14.49, \"url\": \"https://...\", "
        "\"description\": \"...\", \"in_stock\": true}}"
    ),
)

if __name__ == "__main__":
    walgreens.run()
