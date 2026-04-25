"""
CareFlow inter-agent Pydantic message types.
All extend uagents.Model for ctx.send() compatibility.
"""
from typing import Any, Dict, List, Optional
from uagents import Model


class IntakeRequest(Model):
    """FastAPI / CareFlow agent → Orchestrator: process a new intake."""
    run_id: str
    transcript: str
    summary: str
    user_id: str = "anonymous"
    uploaded_image_b64: Optional[str] = None


class RoutingDecision(Model):
    """Orchestrator → FastAPI / CareFlow agent: routing result."""
    run_id: str
    urgency: str  # emergency | urgent | routine | wellness
    recommended_path: str  # doctor | pharmacy | mental_health | alt_medicine | self_care
    summary: str
    next_actions: List[str]
    payment_required: bool = False
    payment_amount_usd: float = 0.0
    requires_doctor_approval: bool = False
    rationale: str = ""
    disclaimers: List[str] = []


class SpecialistTask(Model):
    """Orchestrator → specialist agent."""
    run_id: str
    path: str    # doctor | pharmacy | mental_health | alt_medicine
    params: Dict[str, Any] = {}


class SpecialistResult(Model):
    """Specialist agent → Orchestrator."""
    run_id: str
    path: str
    success: bool
    artifacts: Dict[str, Any] = {}
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Fetch.ai Agent Payment Protocol messages (mirrors kaimon/Stripe horoscope)
# ---------------------------------------------------------------------------

class PaymentRequest(Model):
    run_id: str
    item_name: str
    amount: float
    stripe_session_id: str
    reference: str
    deadline_seconds: int = 120


class PaymentCommit(Model):
    run_id: str
    item_name: str
    transaction_id: str
    reference: str


class PaymentComplete(Model):
    run_id: str
    item_name: str
    reference: str


class PaymentCancel(Model):
    run_id: str
    item_name: str
    reason: str


# ---------------------------------------------------------------------------
# Budget / Shopping Agent messages
# ---------------------------------------------------------------------------

class BudgetRequest(Model):
    """CareFlow orchestrator → Budget Agent: kick off a shopping run."""
    run_id: str
    query: str               # e.g. "cold and flu relief"
    total_budget_usd: float
    requester_address: str   # careflow agent address for callback


class BudgetAllocation(Model):
    """Budget Agent → Seller Agent: here is your share of the budget."""
    run_id: str
    query: str
    allocated_usd: float     # this agent's slice
    total_budget_usd: float
    budget_agent_address: str  # seller sends RequestPayment here


class ShoppingResult(Model):
    """Seller Agent → Budget Agent: here is what I found."""
    run_id: str
    agent_name: str          # cvs | walgreens | goodrx | amazon
    platform: str
    item_name: Optional[str] = None
    item_price: float = 0.0
    item_url: Optional[str] = None
    item_description: Optional[str] = None
    in_stock: bool = False
    wallet_spent: float = 0.0
    wallet_remaining: float = 0.0
    error: Optional[str] = None
