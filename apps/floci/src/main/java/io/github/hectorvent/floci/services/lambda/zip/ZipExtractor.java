package io.github.hectorvent.floci.services.lambda.zip;

import jakarta.enterprise.context.ApplicationScoped;
import org.jboss.logging.Logger;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Extracts ZIP bytes to a target directory.
 * Guards against path traversal attacks by validating entry names.
 */
@ApplicationScoped
public class ZipExtractor {

    private static final Logger LOG = Logger.getLogger(ZipExtractor.class);

    public void extractTo(byte[] zipBytes, Path targetDir) throws IOException {
        // Resolve to absolute path so that normalize() on entry paths stays comparable
        Path absTarget = targetDir.toAbsolutePath().normalize();
        Files.createDirectories(absTarget);

        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String entryName = entry.getName();

                // Security: prevent path traversal
                if (entryName.contains("..") || entryName.startsWith("/")) {
                    LOG.warnv("Skipping suspicious ZIP entry: {0}", entryName);
                    zis.closeEntry();
                    continue;
                }

                Path targetPath = absTarget.resolve(entryName).normalize();
                if (!targetPath.startsWith(absTarget)) {
                    LOG.warnv("Skipping out-of-bounds ZIP entry: {0}", entryName);
                    zis.closeEntry();
                    continue;
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(targetPath);
                } else {
                    Files.createDirectories(targetPath.getParent());
                    try (OutputStream out = Files.newOutputStream(targetPath)) {
                        zis.transferTo(out);
                    }
                }
                zis.closeEntry();
            }
        }

        LOG.debugv("Extracted ZIP to: {0}", absTarget);
    }
}
