from pathlib import Path
from agents.shopping.base import make_seller_agent

goodrx = make_seller_agent(
    name="goodrx",
    port=8105,
    seed="goodrx-seller-seed-la-hacks-2026",
    platform="GoodRx",
    readme_path=str(Path(__file__).parent / "README_goodrx.md"),
    browser_task_template=(
        'Go to goodrx.com and search for "{query}". '
        "Find the best priced medication or OTC product under ${budget:.2f}. "
        "Return ONLY a JSON object with keys: "
        "name (string), price (number), url (string), description (string), in_stock (boolean). "
        "Example: {{\"name\": \"Ibuprofen 200mg\", \"price\": 4.99, \"url\": \"https://...\", "
        "\"description\": \"...\", \"in_stock\": true}}"
    ),
)

if __name__ == "__main__":
    goodrx.run()
