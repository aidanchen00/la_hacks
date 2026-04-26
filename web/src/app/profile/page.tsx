"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import {
  getProfile, updateProfile,
  type UserProfile, type DeductiblePayment, type ProfileEditableFields,
} from "@/lib/api";
import {
  getStoredNullifier, setStoredNullifier, clearStoredNullifier, subscribeNullifier,
} from "@/lib/auth";
import WorldIDGate from "@/components/WorldIDGate";

const SEX_OPTIONS = ["female", "male", "intersex", "prefer_not_to_say"] as const;

// Empty form values keyed to UserProfile, used for both "no profile yet" and reset.
const EMPTY_FORM = {
  display_name: "",
  age: "",
  sex: "",
  gender: "",
  weight_lbs: "",
  height_in: "",
  allergies: "",
  conditions: "",
  medications: "",
  insurance_provider: "",
  insurance_member_id: "",
  insurance_group_id: "",
  deductible_total_usd: "",
  plan_year_start: "",
};
type FormState = typeof EMPTY_FORM;

function profileToForm(p: UserProfile | null): FormState {
  if (!p) return { ...EMPTY_FORM };
  const num = (v: number | null) => (v === null || v === undefined ? "" : String(v));
  return {
    display_name: p.display_name ?? "",
    age: num(p.age),
    sex: p.sex ?? "",
    gender: p.gender ?? "",
    weight_lbs: num(p.weight_lbs),
    height_in: num(p.height_in),
    allergies: p.allergies ?? "",
    conditions: p.conditions ?? "",
    medications: p.medications ?? "",
    insurance_provider: p.insurance_provider ?? "",
    insurance_member_id: p.insurance_member_id ?? "",
    insurance_group_id: p.insurance_group_id ?? "",
    deductible_total_usd: num(p.deductible_total_usd),
    plan_year_start: p.plan_year_start ?? "",
  };
}

function formToPayload(form: FormState): ProfileEditableFields {
  // Convert empty strings → null/undefined; numeric fields → numbers.
  const out: ProfileEditableFields = {};
  out.display_name = form.display_name.trim() || null;
  out.sex = form.sex || null;
  out.gender = form.gender.trim() || null;
  out.allergies = form.allergies;
  out.conditions = form.conditions;
  out.medications = form.medications;
  out.insurance_provider = form.insurance_provider.trim() || null;
  out.insurance_member_id = form.insurance_member_id.trim() || null;
  out.insurance_group_id = form.insurance_group_id.trim() || null;
  out.plan_year_start = form.plan_year_start.trim() || null;
  out.age = form.age === "" ? null : Number(form.age);
  out.weight_lbs = form.weight_lbs === "" ? null : Number(form.weight_lbs);
  out.height_in = form.height_in === "" ? null : Number(form.height_in);
  out.deductible_total_usd = form.deductible_total_usd === "" ? 0 : Number(form.deductible_total_usd);
  return out;
}

export default function ProfilePage() {
  const router = useRouter();
  const [nullifier, setNullifier] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [history, setHistory] = useState<DeductiblePayment[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate login state and subscribe to changes (other tabs / verify flow).
  useEffect(() => {
    setNullifier(getStoredNullifier());
    return subscribeNullifier((h) => setNullifier(h));
  }, []);

  const fetchProfile = useCallback(async (hash: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getProfile(hash);
      setProfile(data.profile);
      setHistory(data.deductible_history ?? []);
      setForm(profileToForm(data.profile));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!nullifier) { setLoading(false); return; }
    fetchProfile(nullifier);
  }, [nullifier, fetchProfile]);

  const handleVerified = (hash: string) => {
    if (!hash) return;
    setStoredNullifier(hash);
    setNullifier(hash);
  };

  const handleLogout = () => {
    clearStoredNullifier();
    setNullifier(null);
    setProfile(null);
    setHistory([]);
    setForm(EMPTY_FORM);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nullifier) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProfile(nullifier, formToPayload(form));
      setProfile(updated.profile);
      setForm(profileToForm(updated.profile));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const update = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
  };

  // ---------------- Login gate ----------------
  if (!nullifier && !loading) {
    return (
      <div className="min-h-screen bg-[#F4F1EA] flex items-center justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl p-7 max-w-md w-full"
        >
          <div className="mb-1 text-xs uppercase tracking-wider text-[#1F3A2E]/60">Profile</div>
          <h1 className="font-serif text-[#1F3A2E] text-2xl font-medium mb-2">Sign in to access your profile</h1>
          <p className="text-[#3D3D3D] text-sm mb-5 leading-relaxed">
            Prana stays anonymous when you query. Verify with World ID once to unlock a private
            profile that travels with you across sessions, plus deductible tracking.
          </p>
          <WorldIDGate onVerified={handleVerified} />
          <div className="mt-4 text-xs text-[#6B7280]">
            Already used Prana on this device? Verifying again with the same World ID account
            restores your profile.
          </div>
          <div className="mt-6 flex justify-between items-center text-xs">
            <button
              onClick={() => router.push("/")}
              className="text-[#1F3A2E] underline hover:opacity-70"
            >
              ← Back home
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // ---------------- Loading ----------------
  if (loading) {
    return (
      <div className="min-h-screen bg-[#F4F1EA] flex items-center justify-center">
        <p className="font-serif text-[#1F3A2E] text-xl">Loading your profile…</p>
      </div>
    );
  }

  const total = profile?.deductible_total_usd ?? 0;
  const used = profile?.deductible_used_usd ?? 0;
  const remaining = Math.max(total - used, 0);
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/")}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 min-h-[44px] flex items-center"
          >
            ← Home
          </button>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">Your profile</h1>
          <button
            onClick={handleLogout}
            className="ml-auto text-xs text-[#6B7280] hover:text-[#DC2626] underline"
          >
            Sign out
          </button>
        </div>

        <p className="text-xs text-[#6B7280] mb-6">
          Anonymous: tied to your World ID nullifier hash, not your name. Stored locally in this Prana
          deployment&apos;s database. Don&apos;t enter information here that you wouldn&apos;t share with a
          wellness coach. This is not a HIPAA-covered medical record.
        </p>

        {/* Deductible card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl p-5 mb-6"
        >
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="font-serif text-[#1F3A2E] text-lg font-medium">Deductible this plan year</h2>
            {profile?.plan_year_start && (
              <span className="text-xs text-[#6B7280]">since {profile.plan_year_start}</span>
            )}
          </div>
          {total <= 0 ? (
            <p className="text-sm text-[#6B7280]">Set your annual deductible below to start tracking.</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-sm text-[#3D3D3D]">
                  <strong className="text-[#1F3A2E]">${used.toFixed(2)}</strong> used of ${total.toFixed(2)}
                </span>
                <span className="text-sm text-[#16A34A] font-semibold">${remaining.toFixed(2)} left</span>
              </div>
              <div className="w-full bg-[#F4F1EA] rounded-full h-2.5 overflow-hidden">
                <div
                  className="h-full bg-[#1F3A2E] transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-[#6B7280] mt-2">
                Both doctor visits and pharmacy purchases booked through Prana count toward this total.
              </p>
            </>
          )}

          {history.length > 0 && (
            <details className="mt-4 group">
              <summary className="text-xs text-[#1F3A2E] cursor-pointer select-none hover:opacity-70">
                Payment history ({history.length})
              </summary>
              <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                {history.map((h) => (
                  <div key={h.id} className="text-xs flex justify-between bg-white rounded-lg px-3 py-2 border border-[#1F3A2E]/10">
                    <span className="text-[#3D3D3D]">
                      {new Date(h.created_at).toLocaleDateString()}
                      <span className="ml-2 uppercase text-[10px] tracking-wider text-[#6B7280]">{h.source}</span>
                    </span>
                    <span className="font-semibold text-[#1F3A2E]">${h.amount_usd.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </motion.div>

        {/* Editable form */}
        <form onSubmit={handleSave} className="space-y-6">
          {/* About */}
          <section className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl p-5">
            <h3 className="font-serif text-[#1F3A2E] text-lg font-medium mb-4">About you</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#6B7280] mb-1.5">Display name (optional)</label>
                <input
                  value={form.display_name} onChange={update("display_name")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Age</label>
                <input
                  type="number" min={0} max={120}
                  value={form.age} onChange={update("age")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Sex (assigned at birth)</label>
                <select
                  value={form.sex} onChange={update("sex")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                >
                  <option value="">—</option>
                  {SEX_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Gender (optional, free-form)</label>
                <input
                  value={form.gender} onChange={update("gender")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Weight (lbs)</label>
                <input
                  type="number" min={0} max={1000} step={0.1}
                  value={form.weight_lbs} onChange={update("weight_lbs")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Height (in)</label>
                <input
                  type="number" min={0} max={100} step={0.1}
                  value={form.height_in} onChange={update("height_in")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
            </div>
          </section>

          {/* Medical */}
          <section className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl p-5">
            <h3 className="font-serif text-[#1F3A2E] text-lg font-medium mb-1">Medical context</h3>
            <p className="text-xs text-[#6B7280] mb-4">
              Used to personalize the routing assistant. Comma-separate multiple entries.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Allergies</label>
                <input
                  value={form.allergies} onChange={update("allergies")}
                  placeholder="e.g. penicillin, sulfa, peanuts"
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Known conditions</label>
                <input
                  value={form.conditions} onChange={update("conditions")}
                  placeholder="e.g. asthma, hypertension"
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Current medications</label>
                <input
                  value={form.medications} onChange={update("medications")}
                  placeholder="e.g. albuterol, lisinopril 10mg"
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
            </div>
          </section>

          {/* Insurance */}
          <section className="bg-[#EFEAE0] border border-[#1F3A2E]/10 rounded-2xl p-5">
            <h3 className="font-serif text-[#1F3A2E] text-lg font-medium mb-1">Insurance &amp; deductible</h3>
            <p className="text-xs text-[#6B7280] mb-4">
              Member ID is stored as plain text in this deployment&apos;s SQLite — only enter it if you
              control the database. We never include it in any LLM prompt.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#6B7280] mb-1.5">Insurance provider</label>
                <input
                  value={form.insurance_provider} onChange={update("insurance_provider")}
                  placeholder="Blue Shield, Kaiser, Aetna, …"
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Member ID</label>
                <input
                  value={form.insurance_member_id} onChange={update("insurance_member_id")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Group ID</label>
                <input
                  value={form.insurance_group_id} onChange={update("insurance_group_id")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Annual deductible (USD)</label>
                <input
                  type="number" min={0} step={50}
                  value={form.deductible_total_usd} onChange={update("deductible_total_usd")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Plan year start</label>
                <input
                  type="date"
                  value={form.plan_year_start} onChange={update("plan_year_start")}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>
            </div>
          </section>

          {error && (
            <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-xl px-4 py-3 text-sm text-[#DC2626]">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3">
            <motion.button
              type="submit"
              disabled={saving}
              whileTap={{ scale: 0.98 }}
              className="bg-[#1F3A2E] text-white rounded-full px-6 py-3 font-medium text-sm hover:bg-[#2A4D3D] disabled:opacity-40 min-h-[48px]"
            >
              {saving ? "Saving…" : "Save profile"}
            </motion.button>
            {savedAt && Date.now() - savedAt < 4000 && (
              <span className="text-sm text-[#16A34A]">✓ Saved</span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
