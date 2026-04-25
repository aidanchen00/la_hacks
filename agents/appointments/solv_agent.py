"""Solv (urgent care + same-day) appointment-search Fetch.ai agent."""
from agents.shopping.base import make_seller_agent

solv = make_seller_agent(
    name="solv",
    port=8110,
    seed="solv-seller-seed-la-hacks-2026",
    platform="Solv",
    browser_task_template=(
        'Go to solvhealth.com and search for "{query}". '
        "Find a same-day or next-day appointment slot under ${budget:.2f}. "
        "Return ONLY a JSON object with keys: "
        "name (string — clinic name), price (number — visit cost USD), url (string — listing URL), "
        "description (string — clinic + address + earliest time), in_stock (boolean — true if same/next-day slot exists)."
    ),
)

if __name__ == "__main__":
    solv.run()
