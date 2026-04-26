"""Healthgrades appointment-search Fetch.ai agent."""
from agents.appointments.base import make_appointment_agent

healthgrades = make_appointment_agent(
    name="healthgrades",
    port=8109,
    seed="healthgrades-seller-seed-la-hacks-2026",
    platform="Healthgrades",
    base_url="https://www.healthgrades.com",
)

if __name__ == "__main__":
    healthgrades.run()
