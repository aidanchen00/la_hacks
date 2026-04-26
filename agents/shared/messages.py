"""
Prana inter-agent Pydantic message types.
All extend uagents.Model for ctx.send() compatibility.
"""
from typing import Any, Dict, List, Optional
from uagents import Model


class IntakeRequest(Model):
    """FastAPI / Prana agent → Orchestrator: process a new intake."""
    run_id: str
    transcript: str
    summary: str
    user_id: str = "anonymous"
    uploaded_image_b64: Optional[str] = None


class RoutingDecision(Model):
    """Orchestrator → FastAPI / Prana agent: routing result."""
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
# Fetch.ai Agent Payment Protocol messages (Stripe horoscope pattern)
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
    """Prana orchestrator → Budget Agent: kick off a shopping run."""
    run_id: str
    query: str               # e.g. "cold and flu relief"
    total_budget_usd: float
    requester_address: str   # prana agent address for callback


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


# ---------------------------------------------------------------------------
# Ranker Agent messages
# ---------------------------------------------------------------------------

class RankCandidate(Model):
    """One option discovered by a search agent, fed to the ranker."""
    source_agent: str        # cvs | walgreens | goodrx | zocdoc | healthgrades | solv ...
    name: str
    price: float = 0.0       # 0 if unknown — ranker fills with realistic estimate
    url: Optional[str] = None
    description: Optional[str] = None
    metadata: Dict[str, Any] = {}   # specialty, address, time, accepts_insurance, in_stock, ...


class RankRequest(Model):
    """Caller → Ranker Agent: rank these candidates and pick which to book/buy."""
    run_id: str
    domain: str              # "pharmacy" | "doctor"
    query: str
    intake_summary: str = ""
    urgency: str = "wellness"
    requires_doctor_approval: bool = False
    total_budget_usd: float = 0.0
    per_agent_budget_usd: float = 0.0
    candidates: List[RankCandidate] = []
    requester_address: Optional[str] = None


class RankedItem(Model):
    """One ranked candidate."""
    source_agent: str
    name: str
    price: float
    url: Optional[str] = None
    description: Optional[str] = None
    metadata: Dict[str, Any] = {}
    score: float = 0.0       # 0..1
    rationale: str = ""
    selected: bool = False


class RankerResult(Model):
    """Ranker Agent → caller: ranked list + selected subset."""
    run_id: str
    domain: str
    ranked_items: List[RankedItem] = []
    selected_total_usd: float = 0.0
    selection_rationale: str = ""


# ---------------------------------------------------------------------------
# Doctor appointment search messages (parallel to pharmacy BudgetRequest flow)
# ---------------------------------------------------------------------------

class AppointmentSearchRequest(Model):
    """Prana → ZocDoc/Healthgrades/Solv: search for providers."""
    run_id: str
    query: str            # specialty, e.g. "primary care"
    location: str         # e.g. "Los Angeles, CA"
    requester_address: str


class AppointmentResult(Model):
    """ZocDoc/Healthgrades/Solv → Prana: parsed provider list."""
    run_id: str
    agent_name: str       # zocdoc | healthgrades | solv
    platform: str         # ZocDoc | Healthgrades | Solv
    # providers is a list of dicts with: provider, specialty, time, address,
    # listingUrl, acceptsInsurance — kept as Dict for forward compatibility.
    providers: List[Dict[str, Any]] = []
    error: Optional[str] = None
