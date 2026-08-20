"use client";

import { type ReactNode, useRef, useState } from "react";
import type { CollaborationLock, ProjectData, TrashData } from "../types";
import ActionIconButton from "./ActionIconButton";
import AppUpdateControl from "./AppUpdateControl";
import TabletUrlBar from "./TabletUrlBar";

interface ProjectListScreenProps {
  projects: ProjectData[];
  trash: TrashData;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (id: string, newName: string) => void;
  onDeleteProject: (id: string) => void;
  onRestoreProject: (trashItemId: string) => void;
  onRestoreRoomType: (trashItemId: string) => void;
  onEmptyTrash: () => void;
  onExportProjects: (projects: ProjectData[], filenamePrefix?: string) => void;
  onImportProjects: (file: File) => void;
  collaborationBar?: ReactNode;
  canEdit?: boolean;
  canCreateProject?: boolean;
  projectLocks?: CollaborationLock[];
}

export default function ProjectListScreen({
  projects,
  trash,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onRestoreProject,
  onRestoreRoomType,
  onEmptyTrash,
  onExportProjects,
  onImportProjects,
  collaborationBar,
  canEdit = true,
  canCreateProject,
  projectLocks = [],
}: ProjectListScreenProps) {
  const [newProjectName, setNewProjectName] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const trashCount = trash.projects.length + trash.roomTypes.length;
  const projectCreationEnabled = canCreateProject ?? canEdit;
  const projectLockById = new Map(
    projectLocks
      .filter((lock) => lock.projectId)
      .map((lock) => [lock.projectId, lock]),
  );

  function submit(): void {
    if (!projectCreationEnabled) return;
    const trimmed = newProjectName.trim();
    if (!trimmed) return;
    if (projects.some((p) => p.name === trimmed)) {
      window.alert("A project with the same name already exists.");
      return;
    }
    onCreateProject(trimmed);
    setNewProjectName("");
  }

  function rename(project: ProjectData): void {
    if (!canEdit) return;
    const next = window.prompt("Enter a new project name.", project.name);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === project.name) return;
    if (projects.some((p) => p.id !== project.id && p.name === trimmed)) {
      window.alert("A project with the same name already exists.");
      return;
    }
    onRenameProject(project.id, trimmed);
  }

  function remove(project: ProjectData): void {
    if (!canEdit) return;
    onDeleteProject(project.id);
  }

  return (
    <main className="app-shell project-list-shell">
      <div className="project-list-top-tools" aria-label="Project selection tools">
        <AppUpdateControl />
        <TabletUrlBar />
      </div>
      <header className="app-header fade-in">
        <h1 className="app-title project-selection-title">CFS Project Selection</h1>
      </header>
      {collaborationBar}

      <section className="card card-padded screen-management-card fade-in">
        <div className="selector-row">
          <input
            className="input"
            type="text"
            placeholder="New project name"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={!projectCreationEnabled}
          />
          <button className="btn btn-primary" onClick={submit} disabled={!projectCreationEnabled}>
            Create Project
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => importInputRef.current?.click()}
            disabled={!canEdit}
          >
            Import Data
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => onExportProjects(projects)}
            disabled={projects.length === 0}
          >
            Export All
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json,.qjson"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImportProjects(file);
              event.currentTarget.value = "";
            }}
          />
        </div>

        <div className="screen-list-panel">
        <h2 className="screen-section-title">Project List</h2>
        {projects.length === 0 ? (
          <p className="screen-empty">
            No projects yet. Create one from the form above.
          </p>
        ) : (
          <ul className="screen-list">
            {projects.map((project) => (
              <li key={project.id} className="screen-card-wrap">
                <button
                  className="screen-card"
                  onClick={() => onSelectProject(project.id)}
                >
                  <span className="screen-card-title">{project.name}</span>
                  <span className="screen-card-meta">
                    <span>Updated {new Date(project.updatedAt).toLocaleString("en-US")}</span>
                    {project.lastUpdatedBy ? (
                      <span>Last saved by {project.lastUpdatedBy.displayName}</span>
                    ) : null}
                    {projectLockById.get(project.id) ? (
                      <span>Locked by {projectLockById.get(project.id)?.userName}</span>
                    ) : null}
                    <span>{project.roomTypes.length} room types</span>
                  </span>
                </button>
                <div className="screen-card-actions">
                  <ActionIconButton
                    icon="edit"
                    label="Rename Project"
                    className="btn-secondary btn-sm"
                    onClick={() => rename(project)}
                    disabled={!canEdit}
                  />
                  <ActionIconButton
                    icon="export"
                    label="Export Project"
                    className="btn-secondary btn-sm"
                    onClick={() => onExportProjects([project], project.name)}
                  />
                  <ActionIconButton
                    icon="trash"
                    label="Delete Project"
                    className="btn-danger-ghost btn-sm"
                    onClick={() => remove(project)}
                    disabled={!canEdit}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        </div>
      </section>

      <section className="card card-padded screen-management-card fade-in">
        <div className="trash-header">
          <div>
            <h2 className="screen-section-title">Trash</h2>
            <p className="trash-meta">
              {trashCount === 0
                ? "Trash is empty."
                : `${trashCount} item${trashCount === 1 ? "" : "s"} waiting for permanent deletion.`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-danger-ghost"
            onClick={onEmptyTrash}
            disabled={trashCount === 0 || !canEdit}
          >
            Empty Trash
          </button>
        </div>

        {trashCount > 0 ? (
          <div className="trash-sections">
            {trash.projects.length > 0 ? (
              <div className="trash-section">
                <h3 className="trash-section-title">Projects</h3>
                <ul className="trash-list">
                  {trash.projects.map((item) => (
                    <li key={item.id} className="trash-row">
                      <div className="trash-row-main">
                        <span className="trash-row-title">{item.project.name}</span>
                        <span className="trash-row-meta">
                          Deleted {new Date(item.deletedAt).toLocaleString("en-US")} / {item.project.roomTypes.length} room types
                        </span>
                      </div>
                      <ActionIconButton
                        icon="restore"
                        label="Restore Project"
                        className="btn-secondary btn-sm"
                        onClick={() => onRestoreProject(item.id)}
                        disabled={!canEdit}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {trash.roomTypes.length > 0 ? (
              <div className="trash-section">
                <h3 className="trash-section-title">Room Types</h3>
                <ul className="trash-list">
                  {trash.roomTypes.map((item) => (
                    <li key={item.id} className="trash-row">
                      <div className="trash-row-main">
                        <span className="trash-row-title">{item.roomType.name}</span>
                        <span className="trash-row-meta">
                          From {item.projectName || "Unknown Project"} / Deleted {new Date(item.deletedAt).toLocaleString("en-US")}
                        </span>
                      </div>
                      <ActionIconButton
                        icon="restore"
                        label="Restore Room Type"
                        className="btn-secondary btn-sm"
                        onClick={() => onRestoreRoomType(item.id)}
                        disabled={!canEdit}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
