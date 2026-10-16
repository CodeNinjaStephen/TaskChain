// lib/proposals.ts
//
// Service layer for proposal operations and the atomic
// proposal-acceptance → contract-creation flow.
//
// All DB access goes through this module so route handlers stay thin and
// the logic is independently unit-testable.  The acceptance flow runs
// inside a single BEGIN/COMMIT block to guarantee atomicity: if any step
// fails, the entire transaction rolls back and no partial state is left.
//
// Column mapping: DB snake_case ←→ JS camelCase (done manually — no ORM).

import { neon } from '@neondatabase/serverless'

// ─── Types ────────────────────────────────────────────────────────────────

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn'

/** A single milestone entry inside proposal.milestoneBreakdown */
export interface ProposalMilestone {
  title: string
  description?: string
  amount: number
  due_date?: string // ISO-8601 date string, optional
}

export interface Proposal {
  id: string
  projectId: string
  freelancerId: string
  coverLetter: string
  proposedAmount: number
  currency: string
  estimatedDuration: string | null
  milestoneBreakdown: ProposalMilestone[]
  status: ProposalStatus
  contractId: string | null
  acceptedAt: string | null
  rejectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AcceptProposalResult {
  proposal: Proposal
  contract: {
    id: string
    projectId: string
    clientId: string
    freelancerId: string
    status: string
    escrowStatus: string
    totalAmount: number
    currency: string
    proposalId: string
    createdAt: string
    updatedAt: string
  }
  milestones: Array<{
    id: string
    contractId: string
    projectId: string
    title: string
    description: string | null
    amount: number
    currency: string
    dueDate: string | null
    sortOrder: number
    status: string
    createdAt: string
  }>
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class ProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`Proposal ${proposalId} not found`)
    this.name = 'ProposalNotFoundError'
  }
}

export class ProposalAlreadyAcceptedError extends Error {
  constructor(proposalId: string) {
    super(`Proposal ${proposalId} has already been accepted`)
    this.name = 'ProposalAlreadyAcceptedError'
  }
}

export class ProposalNotPendingError extends Error {
  constructor(status: string) {
    super(`Proposal cannot be accepted from status '${status}'`)
    this.name = 'ProposalNotPendingError'
  }
}

export class ProjectAlreadyContractedError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} already has an accepted proposal`)
    this.name = 'ProjectAlreadyContractedError'
  }
}

export class ProjectNotActiveError extends Error {
  constructor(status: string) {
    super(`Project cannot accept proposals in status '${status}'`)
    this.name = 'ProjectNotActiveError'
  }
}

export class UnauthorizedAcceptanceError extends Error {
  constructor() {
    super('Only the project client can accept a proposal')
    this.name = 'UnauthorizedAcceptanceError'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function rowToProposal(row: Record<string, unknown>): Proposal {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    freelancerId: row.freelancer_id as string,
    coverLetter: row.cover_letter as string,
    proposedAmount: Number(row.proposed_amount),
    currency: row.currency as string,
    estimatedDuration: (row.estimated_duration as string | null) ?? null,
    milestoneBreakdown: (row.milestone_breakdown as ProposalMilestone[]) ?? [],
    status: row.status as ProposalStatus,
    contractId: (row.contract_id as string | null) ?? null,
    acceptedAt:
      row.accepted_at instanceof Date
        ? row.accepted_at.toISOString()
        : (row.accepted_at as string | null) ?? null,
    rejectedAt:
      row.rejected_at instanceof Date
        ? row.rejected_at.toISOString()
        : (row.rejected_at as string | null) ?? null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string),
  }
}

/** Returns a direct Neon connection that supports transaction-mode queries. */
function getTxDb() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is not set. ' +
        'Copy env.example to .env and fill in your Neon connection string.',
    )
  }
  return neon(url)
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetches a single proposal by its UUID.  Returns null if not found.
 */
export async function getProposalById(id: string): Promise<Proposal | null> {
  const db = getTxDb()
  const rows = (await db('SELECT * FROM proposals WHERE id = $1 LIMIT 1', [id])) as Record<
    string,
    unknown
  >[]
  if (rows.length === 0) return null
  return rowToProposal(rows[0])
}

/**
 * Atomically accepts a freelancer proposal and creates the resulting
 * contract + milestone records.
 *
 * Steps (all within a single DB transaction):
 *  1. Lock & validate the proposal (must be 'pending').
 *  2. Verify the caller is the project's client.
 *  3. Verify the project is in an acceptable state (open / in_progress).
 *  4. Mark the proposal 'accepted'.
 *  5. Reject all other pending proposals for the same project.
 *  6. Create the contract record (status='pending', escrow_status='unfunded').
 *  7. Update the proposal's contract_id back-reference.
 *  8. Create milestone rows from proposal.milestone_breakdown.
 *  9. Advance the project status to 'in_progress'.
 * 10. Insert an admin_audit_log entry for traceability.
 *
 * @param proposalId  UUID of the proposal to accept.
 * @param clientId    UUID of the authenticated user (must be project client).
 * @returns           The updated proposal, the new contract, and the milestones.
 */
export async function acceptProposal(
  proposalId: string,
  clientId: string,
): Promise<AcceptProposalResult> {
  const db = getTxDb()

  // ── Begin transaction ────────────────────────────────────────────────────
  await db('BEGIN', [])

  try {
    // ── Step 1: Lock & fetch the proposal ───────────────────────────────────
    const proposalRows = (await db(
      'SELECT * FROM proposals WHERE id = $1 FOR UPDATE',
      [proposalId],
    )) as Record<string, unknown>[]

    if (proposalRows.length === 0) {
      throw new ProposalNotFoundError(proposalId)
    }

    const proposalRow = proposalRows[0]

    if (proposalRow.status === 'accepted') {
      throw new ProposalAlreadyAcceptedError(proposalId)
    }
    if (proposalRow.status !== 'pending') {
      throw new ProposalNotPendingError(proposalRow.status as string)
    }

    const projectId = proposalRow.project_id as string
    const freelancerId = proposalRow.freelancer_id as string
    const proposedAmount = Number(proposalRow.proposed_amount)
    const currency = proposalRow.currency as string
    const milestoneBreakdown = (proposalRow.milestone_breakdown as ProposalMilestone[]) ?? []

    // ── Step 2: Verify caller is the project client ──────────────────────────
    const projectRows = (await db(
      'SELECT id, client_id, status FROM projects WHERE id = $1 FOR UPDATE',
      [projectId],
    )) as Record<string, unknown>[]

    if (projectRows.length === 0) {
      throw new ProposalNotFoundError(projectId) // project vanished
    }

    const project = projectRows[0]

    if (project.client_id !== clientId) {
      throw new UnauthorizedAcceptanceError()
    }

    // ── Step 3: Validate project state ──────────────────────────────────────
    const projectStatus = project.status as string
    if (!['open', 'in_progress', 'draft'].includes(projectStatus)) {
      throw new ProjectNotActiveError(projectStatus)
    }

    // ── Step 4: Mark proposal as accepted ───────────────────────────────────
    const acceptedRows = (await db(
      `UPDATE proposals
          SET status      = 'accepted',
              accepted_at = NOW(),
              updated_at  = NOW()
        WHERE id = $1
        RETURNING *`,
      [proposalId],
    )) as Record<string, unknown>[]

    const acceptedProposal = acceptedRows[0]

    // ── Step 5: Reject remaining pending proposals for this project ─────────
    await db(
      `UPDATE proposals
          SET status      = 'rejected',
              rejected_at = NOW(),
              updated_at  = NOW()
        WHERE project_id = $1
          AND id != $2
          AND status = 'pending'`,
      [projectId, proposalId],
    )

    // ── Step 6: Create contract ──────────────────────────────────────────────
    const contractRows = (await db(
      `INSERT INTO contracts (
          project_id, client_id, freelancer_id,
          total_amount, currency,
          status, escrow_status
        ) VALUES ($1, $2, $3, $4, $5, 'pending', 'unfunded')
        RETURNING *`,
      [projectId, clientId, freelancerId, proposedAmount, currency],
    )) as Record<string, unknown>[]

    const contractRow = contractRows[0]
    const contractId = contractRow.id as string

    // ── Step 7: Back-reference proposal → contract ───────────────────────────
    await db(
      `UPDATE proposals
          SET contract_id = $1,
              updated_at  = NOW()
        WHERE id = $2`,
      [contractId, proposalId],
    )

    // ── Step 8: Create milestones from breakdown ─────────────────────────────
    const createdMilestones: Array<{
      id: string
      contractId: string
      projectId: string
      title: string
      description: string | null
      amount: number
      currency: string
      dueDate: string | null
      sortOrder: number
      status: string
      createdAt: string
    }> = []

    for (let i = 0; i < milestoneBreakdown.length; i++) {
      const m = milestoneBreakdown[i]
      const milestoneRows = (await db(
        `INSERT INTO milestones (
            project_id, contract_id,
            title, description,
            amount, currency,
            due_date, sort_order,
            status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
          RETURNING *`,
        [
          projectId,
          contractId,
          m.title,
          m.description ?? null,
          m.amount,
          currency,
          m.due_date ?? null,
          i,
        ],
      )) as Record<string, unknown>[]

      const mr = milestoneRows[0]
      createdMilestones.push({
        id: mr.id as string,
        contractId: mr.contract_id as string,
        projectId: mr.project_id as string,
        title: mr.title as string,
        description: (mr.description as string | null) ?? null,
        amount: Number(mr.amount),
        currency: mr.currency as string,
        dueDate:
          mr.due_date instanceof Date
            ? mr.due_date.toISOString()
            : (mr.due_date as string | null) ?? null,
        sortOrder: Number(mr.sort_order),
        status: mr.status as string,
        createdAt:
          mr.created_at instanceof Date
            ? mr.created_at.toISOString()
            : (mr.created_at as string),
      })
    }

    // ── Step 9: Advance project to 'in_progress' ────────────────────────────
    await db(
      `UPDATE projects
          SET status     = 'in_progress',
              started_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [projectId],
    )

    // ── Step 10: Audit log ───────────────────────────────────────────────────
    await db(
      `INSERT INTO admin_audit_logs (
          admin_user_id, action,
          target_type, target_id, details
        ) VALUES ($1, 'PROPOSAL_ACCEPTED', 'contract', $2, $3::jsonb)`,
      [
        clientId,
        contractId,
        JSON.stringify({
          proposalId,
          projectId,
          freelancerId,
          contractId,
          totalAmount: proposedAmount,
          currency,
          milestoneCount: milestoneBreakdown.length,
          timestamp: new Date().toISOString(),
        }),
      ],
    )

    // ── Commit ───────────────────────────────────────────────────────────────
    await db('COMMIT', [])

    // ── Build return value ───────────────────────────────────────────────────
    const finalProposal = rowToProposal({
      ...acceptedProposal,
      contract_id: contractId,
    })

    const contract = {
      id: contractId,
      projectId: contractRow.project_id as string,
      clientId: contractRow.client_id as string,
      freelancerId: contractRow.freelancer_id as string,
      status: contractRow.status as string,
      escrowStatus: contractRow.escrow_status as string,
      totalAmount: Number(contractRow.total_amount),
      currency: contractRow.currency as string,
      proposalId,
      createdAt:
        contractRow.created_at instanceof Date
          ? contractRow.created_at.toISOString()
          : (contractRow.created_at as string),
      updatedAt:
        contractRow.updated_at instanceof Date
          ? contractRow.updated_at.toISOString()
          : (contractRow.updated_at as string),
    }

    return { proposal: finalProposal, contract, milestones: createdMilestones }
  } catch (err) {
    // Roll back all changes on any error
    await db('ROLLBACK', [])
    throw err
  }
}
