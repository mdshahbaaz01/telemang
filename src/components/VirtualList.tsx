import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface VirtualListProps<T> {
  items: T[];
  estimateSize?: number;
  overscan?: number;
  className?: string;
  emptyState?: ReactNode;
  getKey?: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
}

/**
 * Windowed list renderer. Only rows visible in the scroll viewport are
 * mounted, so lists of thousands of rows stay responsive.
 */
export function VirtualList<T>({
  items,
  estimateSize = 24,
  overscan = 8,
  className,
  emptyState,
  getKey,
  renderItem,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  if (items.length === 0 && emptyState) {
    return <div ref={parentRef} className={className}>{emptyState}</div>;
  }

  return (
    <div ref={parentRef} className={className}>
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((v) => {
          const item = items[v.index];
          return (
            <div
              key={getKey ? getKey(item, v.index) : v.key}
              data-index={v.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${v.start}px)`,
              }}
            >
              {renderItem(item, v.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}