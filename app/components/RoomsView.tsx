"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RoomType } from "../types";
import ActionIconButton from "./ActionIconButton";

interface RoomsViewProps {
  roomTypes: RoomType[];
  onSelectRoomType: (id: string) => void;
  onCreateRoomType: (name: string) => void;
  onDuplicateRoomType: (id: string) => void;
  onExportLutronSpec: (id: string) => void;
  onExportRoomTypeBackup: (id: string) => void;
  onRenameRoomType: (id: string, newName: string) => void;
  onDeleteRoomType: (id: string) => void;
  canEdit?: boolean;
}

export default function RoomsView({
  roomTypes,
  onSelectRoomType,
  onCreateRoomType,
  onDuplicateRoomType,
  onExportLutronSpec,
  onExportRoomTypeBackup,
  onRenameRoomType,
  onDeleteRoomType,
  canEdit = true,
}: RoomsViewProps) {
  const [newRoomName, setNewRoomName] = useState("");
  const [exportMenuRoomTypeId, setExportMenuRoomTypeId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<{ roomTypeId: string; name: string; error: string } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameTarget = renameDraft
    ? roomTypes.find((roomType) => roomType.id === renameDraft.roomTypeId) ?? null
    : null;
  const renameDraftRoomTypeId = renameDraft?.roomTypeId ?? "";

  useEffect(() => {
    if (!exportMenuRoomTypeId) return;
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && exportMenuRef.current?.contains(target)) return;
      setExportMenuRoomTypeId(null);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setExportMenuRoomTypeId(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [exportMenuRoomTypeId]);

  useEffect(() => {
    if (!renameDraftRoomTypeId) return;
    const frame = requestAnimationFrame(() => renameInputRef.current?.focus());
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setRenameDraft(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [renameDraftRoomTypeId]);

  useEffect(() => {
    if (!canEdit) setRenameDraft(null);
  }, [canEdit]);

  useEffect(() => {
    if (renameDraftRoomTypeId && !renameTarget) setRenameDraft(null);
  }, [renameDraftRoomTypeId, renameTarget]);

  function submit(): void {
    if (!canEdit) return;
    const trimmed = newRoomName.trim();
    if (!trimmed) return;
    if (roomTypes.some((rt) => rt.name === trimmed)) {
      window.alert("A room type with the same name already exists.");
      return;
    }
    onCreateRoomType(trimmed);
    setNewRoomName("");
  }

  function rename(rt: RoomType): void {
    if (!canEdit) return;
    setRenameDraft({ roomTypeId: rt.id, name: rt.name, error: "" });
  }

  function submitRename(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    if (!canEdit || !renameDraft || !renameTarget) return;
    const trimmed = renameDraft.name.trim();
    if (!trimmed) {
      setRenameDraft((current) => current ? { ...current, error: "Enter a room type name." } : current);
      return;
    }
    if (trimmed === renameTarget.name) {
      setRenameDraft(null);
      return;
    }
    if (roomTypes.some((other) => other.id !== renameTarget.id && other.name === trimmed)) {
      setRenameDraft((current) => current
        ? { ...current, error: "A room type with the same name already exists." }
        : current);
      return;
    }
    onRenameRoomType(renameTarget.id, trimmed);
    setRenameDraft(null);
  }

  function remove(rt: RoomType): void {
    if (!canEdit) return;
    onDeleteRoomType(rt.id);
  }

  function closeExportMenu(): void {
    setExportMenuRoomTypeId(null);
  }

  return (
    <>
      <section className="card card-padded screen-management-card fade-in">
        <div className="selector-row">
          <input
            className="input"
            type="text"
            placeholder="New room type name"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={!canEdit}
          />
          <button className="btn btn-primary" onClick={submit} disabled={!canEdit}>
            Create Room Type
          </button>
        </div>

        <div className="screen-list-panel">
          <h2 className="screen-section-title">Room Type List</h2>
          {roomTypes.length === 0 ? (
            <p className="screen-empty">
              No room types yet. Create one from the form above.
            </p>
          ) : (
            <ul className="screen-list">
              {roomTypes.map((rt) => (
                <li key={rt.id} className="screen-card-wrap">
                  <button
                    className="screen-card"
                    onClick={() => onSelectRoomType(rt.id)}
                  >
                    <span className="screen-card-title">{rt.name}</span>
                    <span className="screen-card-meta">
                      <span>Revision {rt.revision || "1.00"}</span>
                      <span>Updated {new Date(rt.updatedAt).toLocaleString("en-US")}</span>
                    </span>
                  </button>
                  <div className="screen-card-actions">
                    <ActionIconButton
                      icon="edit"
                      label="Rename Room Type"
                      className="btn-secondary btn-sm"
                      onClick={() => rename(rt)}
                      aria-haspopup="dialog"
                      disabled={!canEdit}
                    />
                    <div
                      className="action-menu-anchor"
                      ref={exportMenuRoomTypeId === rt.id ? exportMenuRef : undefined}
                    >
                      <ActionIconButton
                        icon="export"
                        label="Export Room Type"
                        className={`btn-secondary btn-sm${exportMenuRoomTypeId === rt.id ? " is-active" : ""}`}
                        aria-expanded={exportMenuRoomTypeId === rt.id}
                        aria-haspopup="menu"
                        onClick={() => setExportMenuRoomTypeId((current) => (current === rt.id ? null : rt.id))}
                      />
                      {exportMenuRoomTypeId === rt.id ? (
                        <div className="action-choice-popover room-export-choice-popover" role="menu" aria-label="Room type export options">
                          <p>Export Type</p>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            role="menuitem"
                            onClick={() => {
                              onExportLutronSpec(rt.id);
                              closeExportMenu();
                            }}
                          >
                            LD Export
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            role="menuitem"
                            onClick={() => {
                              onExportRoomTypeBackup(rt.id);
                              closeExportMenu();
                            }}
                          >
                            Share Export
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <ActionIconButton
                      icon="copy"
                      label="Copy Room Type"
                      className="btn-secondary btn-sm"
                      onClick={() => onDuplicateRoomType(rt.id)}
                      disabled={!canEdit}
                    />
                    <ActionIconButton
                      icon="trash"
                      label="Delete Room Type"
                      className="btn-danger-ghost btn-sm"
                      onClick={() => remove(rt)}
                      disabled={!canEdit}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {renameDraft && renameTarget && typeof document !== "undefined" ? createPortal(
        <div
          className="modal-backdrop collaboration-user-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRenameDraft(null);
          }}
        >
          <section
            className="collaboration-user-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="roomTypeRenameTitle"
          >
            <div className="modal-header">
              <div>
                <h2 id="roomTypeRenameTitle">Rename Room Type</h2>
                <p>Update the visible name for this room type.</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setRenameDraft(null)} aria-label="Close">
                x
              </button>
            </div>
            <form className="collaboration-user-fields" onSubmit={submitRename}>
              <label htmlFor="roomTypeRenameInput">
                Room Type Name
                <input
                  ref={renameInputRef}
                  id="roomTypeRenameInput"
                  className="input"
                  value={renameDraft.name}
                  onChange={(event) => setRenameDraft((current) => current
                    ? { ...current, name: event.target.value, error: "" }
                    : current)}
                />
              </label>
              {renameDraft.error ? (
                <p className="collaboration-form-warning" role="alert">
                  {renameDraft.error}
                </p>
              ) : null}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setRenameDraft(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Rename
                </button>
              </div>
            </form>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
