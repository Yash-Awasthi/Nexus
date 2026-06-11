package io.github.hectorvent.floci.core.common.security;

import org.jboss.logging.Logger;
import java.io.IOException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Files;

/**
 * Trust-Boundary Validation Layer for Sovereign Substrate Execution.
 * Ensures all dynamically mounted host paths reside strictly within allowed containment roots,
 * actively preventing directory traversal escapes, symlink redirection attacks, and absolute host mounts.
 */
public class PathBoundaryValidator {

    private static final Logger LOG = Logger.getLogger(PathBoundaryValidator.class);

    /**
     * Resolves, normalizes, and validates that the target hot-reload path is strictly contained within
     * the authorized sandbox workspace directory root.
     *
     * @param targetPathRaw the arbitrary user-controlled host directory parameter to validate.
     * @param allowedRootRaw the secure canonical sandbox root (e.g. ./workspace or ./data/hotreload).
     * @return the fully normalized and validated target Path object.
     * @throws SecurityException if a directory traversal escape or boundary violation is detected.
     */
    public static Path validate(String targetPathRaw, String allowedRootRaw) {
        if (targetPathRaw == null || targetPathRaw.isBlank()) {
            throw new SecurityException("Security boundary violation: target path cannot be null or empty.");
        }
        if (allowedRootRaw == null || allowedRootRaw.isBlank()) {
            throw new SecurityException("Security configuration error: allowed boundary root cannot be null or empty.");
        }

        try {
            Path allowedRoot = Path.of(allowedRootRaw).toAbsolutePath().normalize();
            Path targetPath = Path.of(targetPathRaw).toAbsolutePath().normalize();

            // 1. Enforce active directory containment check using startsWith
            if (!targetPath.startsWith(allowedRoot)) {
                LOG.errorv("Security boundary escape attempt detected! Target: {0} sits outside Root: {1}",
                        targetPathRaw, allowedRootRaw);
                throw new SecurityException("Access Denied: Path escape boundary violation. Target sits outside the designated workspace root.");
            }

            // 2. Resolve true symlink chain paths to prevent target bypasses
            if (Files.exists(targetPath)) {
                Path realTargetPath = targetPath.toRealPath(LinkOption.NOFOLLOW_LINKS);
                Path realAllowedRoot = allowedRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
                if (!realTargetPath.startsWith(realAllowedRoot)) {
                    LOG.errorv("Security boundary escape via symlink traversal detected! Target: {0} resolves to: {1}",
                            targetPathRaw, realTargetPath);
                    throw new SecurityException("Access Denied: Symlink boundary validation failed.");
                }
            }

            LOG.debugv("Path successfully validated within structural boundaries: {0}", targetPath);
            return targetPath;

        } catch (IOException e) {
            throw new SecurityException("Security validation failed due to I/O resolution error: " + e.getMessage(), e);
        }
    }
}
