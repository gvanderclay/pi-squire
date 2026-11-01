/** Compact-list state only. Stable session keys never confer action authority. */
export class WidgetSelection {
	private keys: readonly string[] = [];
	private cap = 0;
	private index = 0;
	private start = 0;
	active = false;

	get selectedKey(): string | undefined {
		return this.keys[this.index];
	}

	get offset(): number {
		return this.start;
	}

	update(keys: readonly string[], cap: number): void {
		const selected: string | undefined = this.selectedKey;
		this.keys = keys;
		this.cap = cap;
		const retained: number = selected === undefined ? -1 : keys.indexOf(selected);
		this.index = retained >= 0 ? retained : Math.max(0, Math.min(this.index, keys.length - 1));
		if (!keys.length || cap === 0) this.leave();
		this.scroll();
	}

	enter(): boolean {
		if (!this.keys.length || this.cap === 0) return false;
		this.active = true;
		this.index = 0;
		this.scroll();
		return true;
	}

	leave(): void {
		this.active = false;
		this.start = 0;
	}

	move(direction: -1 | 1): void {
		if (direction === -1 && this.index === 0) this.leave();
		else this.index = Math.max(0, Math.min(this.keys.length - 1, this.index + direction));
		this.scroll();
	}

	private scroll(): void {
		if (!this.active) {
			this.start = 0;
			return;
		}
		if (this.index < this.start) this.start = this.index;
		if (this.index >= this.start + this.cap) this.start = this.index - this.cap + 1;
		this.start = Math.max(0, Math.min(this.start, this.keys.length - this.cap));
	}
}
