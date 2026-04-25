"""Healthgrades appointment-search Fetch.ai agent."""
from agents.shopping.base import make_seller_agent

healthgrades = make_seller_agent(
    name="healthgrades",
    port=8109,
    seed="healthgrades-seller-seed-la-hacks-2026",
    platform="Healthgrades",
    browser_task_template=(
        'Go to healthgrades.com and search for "{query}". '
        "Find the best-rated provider with the earliest availability under ${budget:.2f}. "
        "Return ONLY a JSON object with keys: "
        "name (string — provider name), price (number — visit cost USD), url (string — listing URL), "
        "description (string — specialty + rating + address + earliest time), in_stock (boolean)."
    ),
)

if __name__ == "__main__":
    healthgrades.run()
