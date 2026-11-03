/** Compact-list state only. Stable keys never confer action authority. */
export class WidgetSelection {
	private keys: readonly string[] = [];
	private breadcrumb = 0;
	private cap = 0;
	private index = 0;
	private start = 0;
	active = false;
	readonly expanded = new Set<string>();

	get selectedKey(): string | undefined {
		return this.keys[this.index];
	}
	get offset(): number {
		return this.start;
	}

	update(children: readonly string[], cap: number, breadcrumbKey?: string): void {
		const selected: string | undefined = this.selectedKey;
		const keys: readonly string[] = [...(breadcrumbKey ? [breadcrumbKey] : []), ...(cap > 0 ? children : [])];
		this.keys = keys;
		this.breadcrumb = breadcrumbKey ? 1 : 0;
		this.cap = cap;
		const retained: number = selected === undefined ? -1 : keys.indexOf(selected);
		this.index = retained >= 0 ? retained : Math.max(0, Math.min(this.index, keys.length - 1));
		if (!keys.length) this.leave();
		this.scroll();
	}

	enter(): boolean {
		if (!this.keys.length) return false;
		this.active = true;
		this.index = 0;
		this.scroll();
		return true;
	}

	select(key: string): void {
		const index = this.keys.indexOf(key);
		if (index < 0) return;
		this.index = index;
		this.scroll();
	}

	leave(): void {
		this.expanded.clear();
		this.active = false;
		this.start = 0;
	}

	move(direction: -1 | 1): void {
		if (direction === -1 && this.index === 0) this.leave();
		else this.index = Math.max(0, Math.min(this.keys.length - 1, this.index + direction));
		this.scroll();
	}

	private scroll(): void {
		const child: number = this.index - this.breadcrumb;
		if (!this.active || child < 0 || this.cap === 0) {
			this.start = 0;
			return;
		}
		if (child < this.start) this.start = child;
		if (child >= this.start + this.cap) this.start = child - this.cap + 1;
		this.start = Math.max(0, Math.min(this.start, this.keys.length - this.breadcrumb - this.cap));
	}
}
