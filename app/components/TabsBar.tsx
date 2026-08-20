"use client";

export interface TabDef {
  id: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
  highlighted?: boolean;
  linkIssueSeverity?: "warning" | "error";
}

interface TabsBarProps {
  tabs: TabDef[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: "primary" | "sub";
}

export default function TabsBar({
  tabs,
  activeId,
  onChange,
  variant = "primary",
}: TabsBarProps) {
  const className = `tabs-bar fade-in${variant === "sub" ? " tabs-bar-sub" : ""}`;
  return (
    <div className={className} role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const hasLinkIssue = Boolean(tab.linkIssueSeverity);
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={tab.disabled}
            className={`tab${active ? " tab-active" : ""}${tab.highlighted ? " tab-highlighted" : ""}${
              hasLinkIssue ? ` tab-link-issue tab-link-issue-${tab.linkIssueSeverity}` : ""
            }`}
            title={hasLinkIssue ? "Link issue detected in this tab" : undefined}
            onClick={() => onChange(tab.id)}
          >
            <span className="tab-label">{tab.label}</span>
            {tab.sublabel ? (
              <span className="tab-sublabel">{tab.sublabel}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
