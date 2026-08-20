interface DuplicationBannerProps {
  title: string;
  items: string[];
}

export default function DuplicationBanner({
  title,
  items,
}: DuplicationBannerProps) {
  if (items.length === 0) return null;

  return (
    <div className="duplication-banner" role="status">
      <div className="duplication-banner-title">{title}</div>
      <ul className="duplication-banner-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
