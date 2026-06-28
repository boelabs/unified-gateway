import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions: BaseLayoutProps = {
	githubUrl: "https://github.com/boelabs/unified-gateway",
	nav: {
		title: (
			<>
				<span className="unified-nav-logo" aria-hidden="true" />
				<span>Unified Gateway</span>
			</>
		),
		url: "/",
	},
};
