// __tests__/api/proposals.test.ts
//
// Unit tests for:
//   - POST /api/proposals/[id]/accept (route handler)
//   - lib/proposals.ts  (service layer)
//
// Strategy:
//   • lib/db sql      → vi.mock, queued with mockResolvedValueOnce (route layer)
//   • @neondatabase/serverless neon() → vi.mock returning a shared dbMock
//     (lib/proposals.ts uses neon() directly for transaction support)
//   • Auth middleware  → vi.mock with injectAuth helper
//   • DATABASE_URL     → set to a dummy value so getTxDb() doesn't throw
//     before neon() is called

// Must be set before lib/proposals.ts is imported
process.env.DATABASE_URL = 'postgres://test:test@localhost/test'

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Shared constants ─────────────────────────────────────────────────────

const TEST_WALLET = 'GCLIENTWALLET00000000000000000000000000000000000000000000'
const TEST_CLIENT_ID = '00000000-0000-0000-0000-aaaaaaaaaaaa'
const TEST_FREELANCER_ID = '00000000-0000-0000-0000-bbbbbbbbbbbb'
const TEST_PROJECT_ID = '00000000-0000-0000-0000-cccccccccccc'
const TEST_PROPOSAL_ID = '00000000-0000-0000-0000-dddddddddddd'
const TEST_CONTRACT_ID = '00000000-0000-0000-0000-eeeeeeeeeeee'

// ─── Mock: auth middleware ────────────────────────────────────────────────

vi.mock('@/lib/auth/middleware', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/middleware')>(
    '@/lib/auth/middleware',
  )
  const injectAuth =
    (handler: (...args: unknown[]) => unknown) =>
    async (request: unknown, ...rest: unknown[]) =>
      handler(
        request,
        { walletAddress: TEST_WALLET, tokenJti: 'test-jti' },
        ...rest,
      )
  return { ...actual, withAuth: injectAuth, withAuthCtx: injectAuth }
})

// ─── Mock: lib/db (sql tagged-template used in the route handler) ─────────

vi.mock('@/lib/db', () => ({ sql: vi.fn() }))

// ─── Mock: @neondatabase/serverless ──────────────────────────────────────
//
// lib/proposals.ts does: const db = neon(url); await db('BEGIN', [])
// We mock neon() to always return the same dbMock so we can queue
// return values on it.

const dbMock = vi.fn()
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => dbMock),
}))

// ─── Imports (after mocks are hoisted) ───────────────────────────────────

import { sql } from '@/lib/db'
import { POST } from '@/app/api/proposals/[id]/accept/route'
import {
  acceptProposal,
  getProposalById,
  ProposalAlreadyAcceptedError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  ProjectNotActiveError,
  UnauthorizedAcceptanceError,
} from '@/lib/proposals'

type SqlMock = ReturnType<typeof vi.fn>

/** Queue sequential return values on the route-level sql mock */
function queueSql(responses: unknown[]) {
  const mock = sql as unknown as SqlMock
  for (const r of responses) mock.mockResolvedValueOnce(r)
}

/** Queue a rejection on the direct-neon dbMock */
function queueDbReject(err: unknown) {
  dbMock.mockRejectedValueOnce(err)
}

/** Queue sequential return values on the direct-neon dbMock.
 *  If an entry is an Error instance it is queued as a rejection so the
 *  service code catches it correctly. */
function queueDb(responses: unknown[]) {
  for (const r of responses) {
    if (r instanceof Error) {
      dbMock.mockRejectedValueOnce(r)
    } else {
      dbMock.mockResolvedValueOnce(r)
    }
  }
}

// ─── Request factory ──────────────────────────────────────────────────────

function makePostRequest(proposalId: string, body?: Record<string, unknown>): NextRequest {
  const url = `http://localhost/api/proposals/${proposalId}/accept`
  return new NextRequest(
    new Request(url, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
}

function routeCtx(proposalId: string) {
  return { params: Promise.resolve({ id: proposalId }) }
}

// ─── Data factories ───────────────────────────────────────────────────────

function proposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEST_PROPOSAL_ID,
    project_id: TEST_PROJECT_ID,
    freelancer_id: TEST_FREELANCER_ID,
    cover_letter: 'I am a great fit',
    proposed_amount: '500.000000',
    currency: 'USDC',
    estimated_duration: '2 weeks',
    milestone_breakdown: [],
    status: 'pending',
    contract_id: null,
    accepted_at: null,
    rejected_at: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  }
}

function projectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: TEST_PROJECT_ID, client_id: TEST_CLIENT_ID, status: 'open', ...overrides }
}

function contractRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEST_CONTRACT_ID,
    project_id: TEST_PROJECT_ID,
    client_id: TEST_CLIENT_ID,
    freelancer_id: TEST_FREELANCER_ID,
    total_amount: '500.000000',
    currency: 'USDC',
    status: 'pending',
    escrow_status: 'unfunded',
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Reset all mocks fully (clears call history and queued return values)
  vi.resetAllMocks()
  // Re-establish the neon() → dbMock binding (resetAllMocks wipes it)
  const mod = await vi.importMock<typeof import('@neondatabase/serverless')>(
    '@neondatabase/serverless',
  )
  vi.mocked(mod.neon).mockReturnValue(dbMock as ReturnType<typeof mod.neon>)
})

// ═══════════════════════════════════════════════════════════════════════════
// Route handler tests — POST /api/proposals/[id]/accept
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/proposals/[id]/accept — route handler', () => {
  // ── Parameter validation ────────────────────────────────────────────────

  it('returns 400 when proposal ID is not a valid UUID', async () => {
    const req = makePostRequest('not-a-uuid')
    const res = await POST(req, routeCtx('not-a-uuid'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_UUID')
  })

  it('returns 400 when request body is not valid JSON', async () => {
    const url = `http://localhost/api/proposals/${TEST_PROPOSAL_ID}/accept`
    const req = new NextRequest(
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid-json}',
      }),
    )
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_JSON')
  })

  it('returns 422 when body fails schema validation', async () => {
    const req = makePostRequest(TEST_PROPOSAL_ID, { notes: 'x'.repeat(1001) })
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('INVALID_REQUEST_BODY')
    expect(body.details).toHaveProperty('notes')
  })

  // ── Auth & role guards ──────────────────────────────────────────────────

  it('returns 401 when authenticated wallet has no user record', async () => {
    queueSql([[]])   // SELECT id, role FROM users → empty
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('USER_NOT_FOUND')
  })

  it('returns 403 when caller has role=freelancer', async () => {
    queueSql([[{ id: TEST_FREELANCER_ID, role: 'freelancer' }]])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('FORBIDDEN')
  })

  // ── Happy path ──────────────────────────────────────────────────────────

  it('returns 201 with proposal, contract, and milestones on success', async () => {
    // Route-level: resolve wallet
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])

    // Service-level transaction (10 steps for empty milestone breakdown)
    queueDb([
      [],                                          // BEGIN
      [proposalRow()],                             // SELECT proposal FOR UPDATE
      [projectRow()],                              // SELECT project FOR UPDATE
      [proposalRow({ status: 'accepted', accepted_at: new Date() })], // UPDATE proposal
      [],                                          // UPDATE reject other proposals
      [contractRow()],                             // INSERT contract
      [],                                          // UPDATE proposal.contract_id
      // (no milestone iterations — empty array)
      [],                                          // UPDATE project status
      [],                                          // INSERT audit log
      [],                                          // COMMIT
    ])

    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.message).toMatch(/accepted/i)
    expect(body.proposal.id).toBe(TEST_PROPOSAL_ID)
    expect(body.contract.id).toBe(TEST_CONTRACT_ID)
    expect(body.contract.escrowStatus).toBe('unfunded')
    expect(body.milestones).toBeInstanceOf(Array)
    expect(body.milestones).toHaveLength(0)
  })

  it('creates milestones from proposal milestone_breakdown', async () => {
    const milestones = [
      { title: 'Design', amount: 200, description: 'UI mockups' },
      { title: 'Dev', amount: 300, description: 'Implementation' },
    ]

    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])

    queueDb([
      [],                                                                // BEGIN
      [proposalRow({ milestone_breakdown: milestones })],               // SELECT proposal
      [projectRow()],                                                    // SELECT project
      [proposalRow({ status: 'accepted', accepted_at: new Date(), milestone_breakdown: milestones })], // UPDATE proposal
      [],                                                                // reject others
      [contractRow()],                                                   // INSERT contract
      [],                                                                // UPDATE proposal.contract_id
      [{                                                                 // INSERT milestone[0]
        id: '00000000-0000-0000-0001-000000000001',
        contract_id: TEST_CONTRACT_ID,
        project_id: TEST_PROJECT_ID,
        title: 'Design',
        description: 'UI mockups',
        amount: '200.000000',
        currency: 'USDC',
        due_date: null,
        sort_order: 0,
        status: 'pending',
        created_at: new Date('2026-01-01'),
      }],
      [{                                                                 // INSERT milestone[1]
        id: '00000000-0000-0000-0001-000000000002',
        contract_id: TEST_CONTRACT_ID,
        project_id: TEST_PROJECT_ID,
        title: 'Dev',
        description: 'Implementation',
        amount: '300.000000',
        currency: 'USDC',
        due_date: null,
        sort_order: 1,
        status: 'pending',
        created_at: new Date('2026-01-01'),
      }],
      [],                                                                // UPDATE project
      [],                                                                // INSERT audit log
      [],                                                                // COMMIT
    ])

    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.milestones).toHaveLength(2)
    expect(body.milestones[0].title).toBe('Design')
    expect(body.milestones[0].amount).toBe(200)
    expect(body.milestones[1].title).toBe('Dev')
    expect(body.milestones[1].sortOrder).toBe(1)
  })

  // ── Domain error propagation ────────────────────────────────────────────

  it('returns 404 when proposal does not exist', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])
    queueDb([
      [],  // BEGIN
      [],  // SELECT proposal → not found (empty array)
      [],  // ROLLBACK
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('PROPOSAL_NOT_FOUND')
  })

  it('returns 409 when proposal is already accepted', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])
    queueDb([
      [],
      [proposalRow({ status: 'accepted' })],
      [],  // ROLLBACK
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PROPOSAL_ALREADY_ACCEPTED')
  })

  it('returns 409 when proposal is rejected (not pending)', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])
    queueDb([
      [],
      [proposalRow({ status: 'rejected' })],
      [],  // ROLLBACK
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PROPOSAL_NOT_PENDING')
  })

  it('returns 409 when project is in a non-acceptable state (completed)', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])
    queueDb([
      [],
      [proposalRow()],
      [projectRow({ status: 'completed' })],
      [],  // ROLLBACK
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PROJECT_NOT_ACTIVE')
  })

  it('returns 403 when caller is not the project client', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])
    queueDb([
      [],
      [proposalRow()],
      [projectRow({ client_id: 'different-client-id' })],
      [],  // ROLLBACK
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('FORBIDDEN')
  })

  it('returns 409 on DB unique constraint violation (concurrent acceptance race)', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])
    queueDb([
      [],
      [proposalRow()],
      [projectRow()],
      [proposalRow({ status: 'accepted', accepted_at: new Date() })],
      [],
      // DB raises unique violation on uq_proposals_one_accepted_per_project
      Object.assign(
        new Error('duplicate key value violates unique constraint "uq_proposals_one_accepted_per_project"'),
        {},
      ),
      [],  // ROLLBACK
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PROJECT_ALREADY_HAS_ACCEPTED_PROPOSAL')
  })

  it('returns 500 on unexpected server error', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'client' }]])
    queueDb([
      [],
      [proposalRow()],
      [projectRow()],
      [proposalRow({ status: 'accepted', accepted_at: new Date() })],
      [],
      Object.assign(new Error('connection reset'), {}),
      [],  // ROLLBACK
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('SERVER_ERROR')
  })

  // ── Admin access ────────────────────────────────────────────────────────

  it('allows admin role to accept a proposal', async () => {
    queueSql([[{ id: TEST_CLIENT_ID, role: 'admin' }]])
    queueDb([
      [],
      [proposalRow()],
      [projectRow()],
      [proposalRow({ status: 'accepted', accepted_at: new Date() })],
      [],
      [contractRow()],
      [],
      [],
      [],
      [],
    ])
    const req = makePostRequest(TEST_PROPOSAL_ID)
    const res = await POST(req, routeCtx(TEST_PROPOSAL_ID))
    expect(res.status).toBe(201)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Service layer tests — lib/proposals.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('getProposalById', () => {
  it('returns null when no proposal exists', async () => {
    dbMock.mockResolvedValueOnce([])   // SELECT * FROM proposals → empty
    const result = await getProposalById(TEST_PROPOSAL_ID)
    expect(result).toBeNull()
  })

  it('maps a DB row to a Proposal object', async () => {
    dbMock.mockResolvedValueOnce([proposalRow()])
    const result = await getProposalById(TEST_PROPOSAL_ID)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(TEST_PROPOSAL_ID)
    expect(result!.projectId).toBe(TEST_PROJECT_ID)
    expect(result!.freelancerId).toBe(TEST_FREELANCER_ID)
    expect(result!.status).toBe('pending')
    expect(result!.proposedAmount).toBe(500)
    expect(result!.milestoneBreakdown).toEqual([])
  })
})

describe('acceptProposal', () => {
  it('throws ProposalNotFoundError when proposal does not exist', async () => {
    queueDb([
      [],  // BEGIN
      [],  // SELECT proposal → empty
      [],  // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow(
      ProposalNotFoundError,
    )
  })

  it('throws ProposalAlreadyAcceptedError for already-accepted proposals', async () => {
    queueDb([
      [],
      [proposalRow({ status: 'accepted' })],
      [],  // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow(
      ProposalAlreadyAcceptedError,
    )
  })

  it('throws ProposalNotPendingError for rejected proposals', async () => {
    queueDb([
      [],
      [proposalRow({ status: 'rejected' })],
      [],  // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow(
      ProposalNotPendingError,
    )
  })

  it('throws ProposalNotPendingError for withdrawn proposals', async () => {
    queueDb([
      [],
      [proposalRow({ status: 'withdrawn' })],
      [],  // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow(
      ProposalNotPendingError,
    )
  })

  it('throws UnauthorizedAcceptanceError when caller is not the project client', async () => {
    queueDb([
      [],
      [proposalRow()],
      [projectRow({ client_id: 'someone-else-uuid' })],
      [],  // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow(
      UnauthorizedAcceptanceError,
    )
  })

  it('throws ProjectNotActiveError for a cancelled project', async () => {
    queueDb([
      [],
      [proposalRow()],
      [projectRow({ client_id: TEST_CLIENT_ID, status: 'cancelled' })],
      [],  // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow(
      ProjectNotActiveError,
    )
  })

  it('throws ProjectNotActiveError for a completed project', async () => {
    queueDb([
      [],
      [proposalRow()],
      [projectRow({ client_id: TEST_CLIENT_ID, status: 'completed' })],
      [],  // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow(
      ProjectNotActiveError,
    )
  })

  it('rolls back and rethrows on unexpected DB error during contract insert', async () => {
    const boom = new Error('DB down')
    queueDb([
      [],                 // BEGIN
      [proposalRow()],    // SELECT proposal
      [projectRow()],     // SELECT project
      [proposalRow({ status: 'accepted', accepted_at: new Date() })],
      [],                 // UPDATE other proposals
      boom,               // INSERT contract → error
      [],                 // ROLLBACK
    ])
    await expect(acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)).rejects.toThrow('DB down')
  })

  it('returns correct AcceptProposalResult shape on success (no milestones)', async () => {
    queueDb([
      [],                 // BEGIN
      [proposalRow()],    // SELECT proposal
      [projectRow()],     // SELECT project
      [proposalRow({ status: 'accepted', accepted_at: new Date() })], // UPDATE proposal
      [],                 // UPDATE other proposals (reject)
      [contractRow()],    // INSERT contract
      [],                 // UPDATE proposal.contract_id
      // no milestone iterations — empty array
      [],                 // UPDATE project status
      [],                 // INSERT audit log
      [],                 // COMMIT
    ])

    const result = await acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)

    expect(result.proposal.id).toBe(TEST_PROPOSAL_ID)
    expect(result.proposal.status).toBe('accepted')
    expect(result.proposal.contractId).toBe(TEST_CONTRACT_ID)

    expect(result.contract.id).toBe(TEST_CONTRACT_ID)
    expect(result.contract.status).toBe('pending')
    expect(result.contract.escrowStatus).toBe('unfunded')
    expect(result.contract.proposalId).toBe(TEST_PROPOSAL_ID)
    expect(result.contract.totalAmount).toBe(500)

    expect(result.milestones).toHaveLength(0)
  })

  it('creates milestone rows matching the breakdown and returns them', async () => {
    const breakdown = [
      { title: 'Phase 1', amount: 200 },
      { title: 'Phase 2', amount: 300 },
    ]

    queueDb([
      [],                                                          // BEGIN
      [proposalRow({ milestone_breakdown: breakdown })],           // SELECT proposal
      [projectRow()],                                              // SELECT project
      [proposalRow({ status: 'accepted', accepted_at: new Date(), milestone_breakdown: breakdown })],
      [],                                                          // reject others
      [contractRow()],                                             // INSERT contract
      [],                                                          // UPDATE proposal.contract_id
      [{                                                           // INSERT milestone[0]
        id: '00000000-0000-0000-0001-000000000001',
        contract_id: TEST_CONTRACT_ID,
        project_id: TEST_PROJECT_ID,
        title: 'Phase 1',
        description: null,
        amount: '200.000000',
        currency: 'USDC',
        due_date: null,
        sort_order: 0,
        status: 'pending',
        created_at: new Date(),
      }],
      [{                                                           // INSERT milestone[1]
        id: '00000000-0000-0000-0001-000000000002',
        contract_id: TEST_CONTRACT_ID,
        project_id: TEST_PROJECT_ID,
        title: 'Phase 2',
        description: null,
        amount: '300.000000',
        currency: 'USDC',
        due_date: null,
        sort_order: 1,
        status: 'pending',
        created_at: new Date(),
      }],
      [],                                                          // UPDATE project
      [],                                                          // INSERT audit log
      [],                                                          // COMMIT
    ])

    const result = await acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)

    expect(result.milestones).toHaveLength(2)
    expect(result.milestones[0].title).toBe('Phase 1')
    expect(result.milestones[0].amount).toBe(200)
    expect(result.milestones[0].sortOrder).toBe(0)
    expect(result.milestones[0].status).toBe('pending')
    expect(result.milestones[1].title).toBe('Phase 2')
    expect(result.milestones[1].sortOrder).toBe(1)
  })

  it('initializes escrow status to unfunded on contract creation', async () => {
    queueDb([
      [],
      [proposalRow()],
      [projectRow()],
      [proposalRow({ status: 'accepted', accepted_at: new Date() })],
      [],
      [contractRow({ escrow_status: 'unfunded' })],
      [],
      [],
      [],
      [],
    ])

    const result = await acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)
    expect(result.contract.escrowStatus).toBe('unfunded')
  })

  it('sets contract status to pending until escrow is funded', async () => {
    queueDb([
      [],
      [proposalRow()],
      [projectRow()],
      [proposalRow({ status: 'accepted', accepted_at: new Date() })],
      [],
      [contractRow({ status: 'pending' })],
      [],
      [],
      [],
      [],
    ])

    const result = await acceptProposal(TEST_PROPOSAL_ID, TEST_CLIENT_ID)
    expect(result.contract.status).toBe('pending')
  })
})
