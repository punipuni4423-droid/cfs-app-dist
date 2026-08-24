"use client";

import { useEffect, useRef, useState } from "react";
import type { CollaborationMembership, CollaborationRole } from "../types";
import type { CollaborationController } from "../lib/useCollaboration";
import { ActionIcon } from "./ActionIconButton";

interface CollaborationBarProps {
  collaboration: CollaborationController;
  compact?: boolean;
  projectUpdatedAt?: string | null;
}

function displayTime(value: string | null | undefined): string {
  if (!value) return "Not saved yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US");
}

function roleLabel(role: CollaborationRole | null | undefined): string {
  return role ? role[0].toUpperCase() + role.slice(1) : "Viewer";
}

function compactMessage(message: string): string {
  const trimmed = message.trim();
  if (/^Signed in\b/i.test(trimmed)) return "Signed in";
  if (/^Started in view mode\b/i.test(trimmed)) return "View mode";
  if (/^Editing started\b/i.test(trimmed)) return "Editing started";
  return trimmed;
}

function isRemoteProjectNewer(remote: string | null | undefined, local: string | null | undefined): boolean {
  if (!remote || !local) return false;
  const remoteTime = Date.parse(remote);
  const localTime = Date.parse(local);
  return Number.isFinite(remoteTime) && Number.isFinite(localTime) && remoteTime > localTime;
}

export default function CollaborationBar({ collaboration, compact = false, projectUpdatedAt = null }: CollaborationBarProps) {
  const [displayName, setDisplayName] = useState(collaboration.user?.displayName || "");
  const [email, setEmail] = useState(collaboration.user?.email || "");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberRole, setMemberRole] = useState<CollaborationRole>("viewer");
  const [memberActive, setMemberActive] = useState(true);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const secure = collaboration.sharingMode === "supabase";
  const signedIn = Boolean(collaboration.user);
  const editing = collaboration.mode === "edit";
  const occupied = Boolean(collaboration.lock && !editing);
  const canStartEditing = !occupied && (!secure || collaboration.role === "editor" || collaboration.role === "admin");
  const canForceRelease = occupied && (!secure ? signedIn : collaboration.role === "admin");
  const hasRemoteProjectUpdate = !editing && isRemoteProjectNewer(collaboration.lastUpdatedAt, projectUpdatedAt);
  const idleMinutes = Math.max(1, Math.round(collaboration.idleMs / 60000));
  const lastUpdatedText = collaboration.lastUpdatedBy
    ? `${collaboration.lastUpdatedBy.displayName} / ${displayTime(collaboration.lastUpdatedBy.updatedAt)}`
    : "Not saved yet";
  const activeAdminCount = collaboration.members.filter((member) => member.role === "admin" && member.active).length;
  const editingMember = editingMemberId ? collaboration.members.find((member) => member.id === editingMemberId) : undefined;
  const wouldRemoveLastAdmin = Boolean(
    editingMember &&
      editingMember.role === "admin" &&
      editingMember.active &&
      activeAdminCount <= 1 &&
      (memberRole !== "admin" || !memberActive),
  );

  useEffect(() => {
    if (!collaboration.userDialogOpen) return;
    setDisplayName(collaboration.user?.displayName || "");
    setEmail(collaboration.user?.email || "");
    window.setTimeout(() => (secure ? undefined : displayNameRef.current?.focus()), 0);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") collaboration.closeUserDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collaboration, secure]);

  useEffect(() => {
    if (!collaboration.membersDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") collaboration.closeMembersDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collaboration]);

  useEffect(() => {
    if (!collaboration.membersDialogOpen) return;
    resetMemberForm();
  }, [collaboration.membersDialogOpen]);

  function resetMemberForm(): void {
    setEditingMemberId(null);
    setMemberEmail("");
    setMemberName("");
    setMemberRole("viewer");
    setMemberActive(true);
  }

  function editMember(member: CollaborationMembership): void {
    setEditingMemberId(member.id);
    setMemberEmail(member.email);
    setMemberName(member.displayName);
    setMemberRole(member.role);
    setMemberActive(member.active);
  }

  async function handleForceRelease(): Promise<void> {
    const owner = collaboration.lock?.userName || "Another user";
    const confirmed = window.confirm(
      `Force-release the edit lock held by ${owner}?\nIf that session is still editing, its unsaved changes may be lost.`,
    );
    if (!confirmed) return;
    await collaboration.forceReleaseLock();
  }

  async function handleSaveMember(): Promise<void> {
    const normalizedEmail = memberEmail.trim().toLowerCase();
    if (!normalizedEmail) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      window.alert("Enter a valid email address.");
      return;
    }
    if (wouldRemoveLastAdmin) {
      window.alert("Register another active Admin before changing the last Admin.");
      return;
    }
    try {
      await collaboration.saveMember({
        email: normalizedEmail,
        displayName: memberName.trim() || normalizedEmail,
        role: memberRole,
        active: memberActive,
      });
      resetMemberForm();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not save the member.");
    }
  }

  if (!collaboration.enabled && !secure) return null;
  const userName = collaboration.user?.displayName || (secure ? "Sign in required" : "Unregistered");
  const primaryText = secure && !signedIn
    ? "Sign in to access shared CFS data."
    : editing
      ? `${userName} is editing.`
      : occupied
        ? `${collaboration.lock?.userName || "Another user"} is editing.`
        : "Editing is available.";
  const compactPrimaryText = secure && !signedIn
    ? "Sign in required"
    : editing
      ? "Editing"
      : occupied
        ? "Locked"
        : "Ready";

  return (
    <>
      <section className={`collaboration-bar${editing ? " is-editing" : " is-viewing"}${compact ? " is-compact" : ""}`} aria-label="Shared editing status">
        <div className="collaboration-status">
          <span className="collaboration-mode-pill">{editing ? "Editing" : secure ? signedIn ? roleLabel(collaboration.role) : "Sign in" : "View Only"}</span>
          <div>
            <span className="collaboration-primary" title={primaryText}>{compact ? compactPrimaryText : primaryText}</span>
            {!compact ? <span className="collaboration-meta">Last saved: {lastUpdatedText}</span> : null}
            {hasRemoteProjectUpdate ? (
              <span className="collaboration-refresh-notice" role="status" title="他のユーザーが保存しました。Editで最新に更新されます。">
                他のユーザーが保存しました。Editで最新に更新されます。
              </span>
            ) : null}
            {collaboration.message ? <span className="collaboration-message" title={collaboration.message}>{compact ? compactMessage(collaboration.message) : collaboration.message}</span> : null}
          </div>
        </div>
        <div className="collaboration-actions">
          {secure && signedIn ? <span className="collaboration-user-chip" title={collaboration.user?.email}>{userName}</span> : null}
          {secure && collaboration.role === "admin" ? (
            <button
              type="button"
              className={compact ? "history-button history-icon-button collaboration-compact-action" : "btn btn-secondary btn-sm"}
              onClick={() => void collaboration.openMembersDialog()}
              disabled={collaboration.busy}
              title="Manage users"
              aria-label="Manage users"
            >
              {compact ? <ActionIcon name="users" /> : "Manage Users"}
            </button>
          ) : null}
          {!secure && (
            <button
              type="button"
              className={compact ? "history-button history-icon-button collaboration-compact-action" : "btn btn-secondary btn-sm"}
              onClick={collaboration.openUserDialog}
              disabled={collaboration.busy}
              title={`User: ${userName}`}
              aria-label={`User: ${userName}`}
            >
              {compact ? <ActionIcon name="user" /> : "User"}
            </button>
          )}
          {editing ? (
            <>
              {!compact ? <span className="collaboration-meta">{idleMinutes} min idle auto view</span> : null}
              <button
                type="button"
                className={compact ? "history-button history-icon-button collaboration-compact-action" : "btn btn-primary btn-sm"}
                onClick={() => void collaboration.finishEditing()}
                disabled={collaboration.busy}
                title="Finish editing"
                aria-label="Finish editing"
              >
                {compact ? <ActionIcon name="finish" /> : "Finish Editing"}
              </button>
            </>
          ) : secure && !signedIn ? (
            <button
              type="button"
              className={compact ? "history-button history-icon-button collaboration-compact-action" : "btn btn-primary btn-sm"}
              onClick={collaboration.openUserDialog}
              disabled={collaboration.busy}
              title="Sign in"
              aria-label="Sign in"
            >
              {compact ? <ActionIcon name="signIn" /> : "Sign in"}
            </button>
          ) : (
            <button
              type="button"
              className={compact ? "history-button history-icon-button collaboration-compact-action" : "btn btn-primary btn-sm"}
              onClick={() => void collaboration.startEditing()}
              disabled={collaboration.busy || !canStartEditing}
              title={occupied ? `${collaboration.lock?.userName || "Another user"} is editing` : secure && !canStartEditing ? "Editor or Admin role is required" : "Start editing"}
              aria-label={occupied ? "Wait for editing lock" : secure && !canStartEditing ? "Editor or Admin role is required" : "Start editing"}
            >
              {occupied ? (compact ? <ActionIcon name="wait" /> : "Wait") : compact ? <ActionIcon name="edit" /> : "Start Editing"}
            </button>
          )}
          {canForceRelease ? (
            <button
              type="button"
              className={compact ? "history-button history-icon-button collaboration-compact-action" : "btn btn-secondary btn-sm"}
              onClick={() => void handleForceRelease()}
              disabled={collaboration.busy}
              title={`Force-release the edit lock held by ${collaboration.lock?.userName || "another user"}`}
              aria-label="Force-release edit lock"
            >
              {compact ? <ActionIcon name="unlock" /> : "Force Unlock"}
            </button>
          ) : null}
          {secure && signedIn ? (
            <button
              type="button"
              className={compact ? "history-button history-icon-button collaboration-compact-action" : "btn btn-secondary btn-sm"}
              onClick={() => void collaboration.signOut()}
              disabled={collaboration.busy || editing}
              title="Sign out"
              aria-label="Sign out"
            >
              {compact ? <ActionIcon name="signOut" /> : "Sign Out"}
            </button>
          ) : null}
        </div>
      </section>

      {collaboration.userDialogOpen ? (
        <div className="modal-backdrop collaboration-user-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) collaboration.closeUserDialog(); }}>
          <section className="collaboration-user-modal" role="dialog" aria-modal="true" aria-labelledby="collaborationUserTitle">
            <div className="modal-header">
              <div>
                <h2 id="collaborationUserTitle">{secure ? "CFS Microsoft Sign In" : "User Registration"}</h2>
                <p>{secure ? "Enter your company email to hint the Microsoft account. Access is granted only after an Admin has added that email." : "Used to show who is editing and who saved last."}</p>
              </div>
              <button type="button" className="icon-button" onClick={collaboration.closeUserDialog} aria-label="Close">&times;</button>
            </div>
            <div className="collaboration-user-fields">
              {!secure ? (
                <label>
                  Display name
                  <input ref={displayNameRef} value={displayName} maxLength={120} onChange={(event) => setDisplayName(event.target.value)} placeholder="e.g. Okada" />
                </label>
              ) : null}
              <label>
                {secure ? "Company email (optional)" : "Email address (optional)"}
                <input value={email} type="email" maxLength={240} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={collaboration.closeUserDialog}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => void (secure ? collaboration.requestMicrosoftSignIn(email) : collaboration.saveUser({ displayName, email }))} disabled={collaboration.busy}>
                {secure ? "Sign in with Microsoft" : "Register"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {collaboration.membersDialogOpen ? (
        <div className="modal-backdrop collaboration-user-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) collaboration.closeMembersDialog(); }}>
          <section className="collaboration-user-modal" role="dialog" aria-modal="true" aria-labelledby="collaborationMembersTitle">
            <div className="modal-header">
              <div>
                <h2 id="collaborationMembersTitle">CFS Sharing Users</h2>
                <p>Add users, or choose Edit on an existing row to change its role or status.</p>
              </div>
              <button type="button" className="icon-button" onClick={collaboration.closeMembersDialog} aria-label="Close">&times;</button>
            </div>
            <div className="collaboration-user-fields">
              <label>Email address<input value={memberEmail} type="email" onChange={(event) => setMemberEmail(event.target.value)} placeholder="name@example.com" disabled={Boolean(editingMemberId)} /></label>
              <label>Display name<input value={memberName} maxLength={120} onChange={(event) => setMemberName(event.target.value)} placeholder="Name shown in CFS" /></label>
              <label>Role<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as CollaborationRole)}><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select></label>
              <label className="checkbox-label"><input type="checkbox" checked={memberActive} onChange={(event) => setMemberActive(event.target.checked)} /> Active</label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => void handleSaveMember()} disabled={collaboration.busy || !memberEmail.trim() || wouldRemoveLastAdmin}>
                {editingMemberId ? "Update User" : "Save User"}
              </button>
              {editingMemberId ? <button type="button" className="btn btn-secondary" onClick={resetMemberForm} disabled={collaboration.busy}>Cancel Edit</button> : null}
              {wouldRemoveLastAdmin ? <span className="collaboration-form-warning">Another active Admin is required first.</span> : null}
            </div>
            <div className="collaboration-members-list" role="list" aria-label="CFS sharing users">
              {collaboration.members.map((member) => (
                <div
                  key={member.id}
                  className={`collaboration-member-row${editingMemberId === member.id ? " is-editing" : ""}`}
                  role="listitem"
                  onClick={() => { if (!collaboration.busy) editMember(member); }}
                  title="Click to edit this user"
                >
                  <span>{member.displayName}</span><span>{member.email}</span><span>{roleLabel(member.role)}</span><span>{member.active ? "Active" : "Disabled"}</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={(event) => { event.stopPropagation(); editMember(member); }} disabled={collaboration.busy}>Edit</button>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
