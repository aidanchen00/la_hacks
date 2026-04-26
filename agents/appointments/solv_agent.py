"""Solv (urgent care + same-day) appointment-search Fetch.ai agent."""
from agents.appointments.base import make_appointment_agent

solv = make_appointment_agent(
    name="solv",
    port=8110,
    seed="solv-seller-seed-la-hacks-2026",
    platform="Solv",
    base_url="https://www.solvhealth.com",
)

if __name__ == "__main__":
    solv.run()
