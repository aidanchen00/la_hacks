"""ZocDoc appointment-search Fetch.ai agent."""
from agents.shopping.base import make_seller_agent

zocdoc = make_seller_agent(
    name="zocdoc",
    port=8108,
    seed="zocdoc-seller-seed-la-hacks-2026",
    platform="ZocDoc",
    browser_task_template=(
        'Go to zocdoc.com and search for "{query}". '
        "Find up to 5 providers with the earliest available appointments under ${budget:.2f}. "
        "Return ONLY a JSON object with keys: "
        "name (string — provider name), price (number — visit cost USD), url (string — listing URL), "
        "description (string — specialty + address + earliest time), in_stock (boolean — true if available)."
    ),
)

if __name__ == "__main__":
    zocdoc.run()
