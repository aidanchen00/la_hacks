from pathlib import Path
from agents.shopping.base import make_seller_agent

amazon = make_seller_agent(
    name="amazon",
    port=8106,
    seed="amazon-seller-seed-la-hacks-2026",
    platform="Amazon",
    readme_path=str(Path(__file__).parent / "README_amazon.md"),
    browser_task_template=(
        'Go to amazon.com and search for "{query}". '
        "Find the best product that costs under ${budget:.2f} with Prime eligibility if possible. "
        "Return ONLY a JSON object with keys: "
        "name (string), price (number), url (string), description (string), in_stock (boolean). "
        "Example: {{\"name\": \"Mucinex DM\", \"price\": 15.99, \"url\": \"https://...\", "
        "\"description\": \"...\", \"in_stock\": true}}"
    ),
)

if __name__ == "__main__":
    amazon.run()
