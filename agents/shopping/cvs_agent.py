from pathlib import Path
from agents.shopping.base import make_seller_agent

cvs = make_seller_agent(
    name="cvs",
    port=8103,
    seed="cvs-seller-seed-la-hacks-2026",
    platform="CVS",
    readme_path=str(Path(__file__).parent / "README_cvs.md"),
    browser_task_template=(
        'Go to cvs.com and search for "{query}". '
        "Find the best OTC product that costs under ${budget:.2f}. "
        "Return ONLY a JSON object with keys: "
        "name (string), price (number), url (string), description (string), in_stock (boolean). "
        "Example: {{\"name\": \"DayQuil\", \"price\": 12.99, \"url\": \"https://...\", "
        "\"description\": \"...\", \"in_stock\": true}}"
    ),
)

if __name__ == "__main__":
    cvs.run()
