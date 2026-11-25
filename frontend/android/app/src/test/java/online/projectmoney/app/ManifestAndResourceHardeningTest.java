package online.projectmoney.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * Plain-JVM checks (no Robolectric) of the source manifest and XML resources that carry the
 * release hardening (Requirements 9.1 - 9.4, 9.6, 9.7, 9.8). They guard against a later edit that
 * silently weakens a setting.
 */
public class ManifestAndResourceHardeningTest {

    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
    private static final String TOOLS_NS = "http://schemas.android.com/tools";

    private static final Set<String> ALL_DOMAINS = new HashSet<>(Arrays.asList(
            "root", "file", "database", "sharedpref", "external",
            "device_root", "device_file", "device_database", "device_sharedpref"));

    // ---- helpers -----------------------------------------------------------------------

    /** Resolves the Gradle app module dir from user.dir: app/, android/app/, or the module itself. */
    private static File appDir() {
        File userDir = new File(System.getProperty("user.dir"));
        File[] candidates = {
            userDir,
            new File(userDir, "app"),
            new File(userDir, "android/app"),
            new File(userDir, "frontend/android/app"),
        };
        for (File candidate : candidates) {
            if (new File(candidate, "src/main/AndroidManifest.xml").isFile()) {
                return candidate;
            }
        }
        throw new IllegalStateException("Cannot locate the app module from user.dir=" + userDir);
    }

    private static Document parse(String relativePath) throws Exception {
        File file = new File(appDir(), relativePath);
        assertTrue("Missing file " + file, file.isFile());
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        return factory.newDocumentBuilder().parse(file);
    }

    private static List<Element> children(Element parent, String tag) {
        List<Element> result = new ArrayList<>();
        NodeList nodes = parent.getChildNodes();
        for (int i = 0; i < nodes.getLength(); i++) {
            Node node = nodes.item(i);
            if (node instanceof Element && tag.equals(node.getNodeName())) {
                result.add((Element) node);
            }
        }
        return result;
    }

    private static Element only(Element parent, String tag) {
        List<Element> found = children(parent, tag);
        assertEquals("Expected exactly one <" + tag + "> in <" + parent.getNodeName() + ">", 1, found.size());
        return found.get(0);
    }

    private static String androidAttr(Element element, String name) {
        return element.hasAttributeNS(ANDROID_NS, name) ? element.getAttributeNS(ANDROID_NS, name) : null;
    }

    private static Element application() throws Exception {
        return only(parse("src/main/AndroidManifest.xml").getDocumentElement(), "application");
    }

    /** Asserts every domain is excluded with path "." and nothing is explicitly included. */
    private static void assertExcludesEverything(Element container) {
        assertTrue("<" + container.getNodeName() + "> must not include anything",
                children(container, "include").isEmpty());
        Set<String> excluded = new HashSet<>();
        for (Element exclude : children(container, "exclude")) {
            assertEquals(".", exclude.getAttribute("path"));
            excluded.add(exclude.getAttribute("domain"));
        }
        assertTrue("<" + container.getNodeName() + "> must exclude every domain, got " + excluded,
                excluded.containsAll(ALL_DOMAINS));
    }

    // ---- AndroidManifest.xml -----------------------------------------------------------

    @Test
    public void manifest_disablesBackupAndReferencesRules() throws Exception {
        Element app = application();
        assertEquals("false", androidAttr(app, "allowBackup"));
        assertEquals("@xml/data_extraction_rules", androidAttr(app, "dataExtractionRules"));
        assertEquals("@xml/backup_rules", androidAttr(app, "fullBackupContent"));
    }

    @Test
    public void manifest_declaresNoCleartextAttributeAndReferencesNetworkSecurityConfig() throws Exception {
        Element app = application();
        assertFalse("main manifest must not declare usesCleartextTraffic",
                app.hasAttributeNS(ANDROID_NS, "usesCleartextTraffic"));
        assertEquals("@xml/network_security_config", androidAttr(app, "networkSecurityConfig"));
        assertFalse("main manifest must not be debuggable",
                "true".equals(androidAttr(app, "debuggable")));
    }

    @Test
    public void manifest_fileProviderIsNotExportedAndGrantsUriPermissions() throws Exception {
        Element providerFound = null;
        for (Element provider : children(application(), "provider")) {
            if ("androidx.core.content.FileProvider".equals(androidAttr(provider, "name"))) {
                providerFound = provider;
            }
        }
        assertNotNull("FileProvider must be declared", providerFound);
        assertEquals("false", androidAttr(providerFound, "exported"));
        assertEquals("true", androidAttr(providerFound, "grantUriPermissions"));
    }

    @Test
    public void manifest_mainActivityIsTheOnlyExportedComponent() throws Exception {
        Element app = application();
        List<String> exported = new ArrayList<>();
        for (String tag : new String[] {"activity", "activity-alias", "service", "receiver", "provider"}) {
            for (Element component : children(app, tag)) {
                if ("true".equals(androidAttr(component, "exported"))) {
                    exported.add(tag + ":" + androidAttr(component, "name"));
                }
            }
        }
        assertEquals(Arrays.asList("activity:.MainActivity"), exported);
    }

    @Test
    public void manifest_declaresOnlyInternetAndAccessNetworkStatePermissions() throws Exception {
        // VIBRATE and the signature-level DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION are added by
        // libraries at merge time; the audit (auditManifest.mjs) checks the merged manifest.
        Element manifest = parse("src/main/AndroidManifest.xml").getDocumentElement();
        Set<String> declared = new HashSet<>();
        for (Element uses : children(manifest, "uses-permission")) {
            declared.add(androidAttr(uses, "name"));
        }
        assertEquals(new HashSet<>(Arrays.asList(
                "android.permission.INTERNET",
                "android.permission.ACCESS_NETWORK_STATE")), declared);
        assertTrue("source manifest must not declare <permission>", children(manifest, "permission").isEmpty());
    }

    @Test
    public void manifest_removesProfileInstallReceiver() throws Exception {
        boolean removed = false;
        for (Element receiver : children(application(), "receiver")) {
            if ("androidx.profileinstaller.ProfileInstallReceiver".equals(androidAttr(receiver, "name"))) {
                assertEquals("remove", receiver.getAttributeNS(TOOLS_NS, "node"));
                removed = true;
            }
        }
        assertTrue("ProfileInstallReceiver tools:node=remove entry must exist", removed);
    }

    // ---- network security configs ------------------------------------------------------

    @Test
    public void mainNetworkSecurityConfig_forbidsCleartextAndTrustsSystemOnly() throws Exception {
        Element root = parse("src/main/res/xml/network_security_config.xml").getDocumentElement();
        Element base = only(root, "base-config");
        assertEquals("false", base.getAttribute("cleartextTrafficPermitted"));
        List<Element> certificates = children(only(base, "trust-anchors"), "certificates");
        assertEquals(1, certificates.size());
        assertEquals("system", certificates.get(0).getAttribute("src"));
        assertTrue("main config must not define domain-config overrides", children(root, "domain-config").isEmpty());
        assertTrue("main config must not define debug-overrides", children(root, "debug-overrides").isEmpty());
        NodeList all = root.getElementsByTagName("certificates");
        for (int i = 0; i < all.getLength(); i++) {
            assertFalse("user trust anchors are not allowed",
                    "user".equals(((Element) all.item(i)).getAttribute("src")));
        }
    }

    @Test
    public void debugNetworkSecurityConfig_permitsCleartextOnlyToEmulatorHostAndLocalhost() throws Exception {
        Element root = parse("src/debug/res/xml/network_security_config.xml").getDocumentElement();
        assertEquals("false", only(root, "base-config").getAttribute("cleartextTrafficPermitted"));
        List<Element> domainConfigs = children(root, "domain-config");
        assertEquals(1, domainConfigs.size());
        Element domainConfig = domainConfigs.get(0);
        assertEquals("true", domainConfig.getAttribute("cleartextTrafficPermitted"));
        Set<String> hosts = new HashSet<>();
        for (Element domain : children(domainConfig, "domain")) {
            assertEquals("false", domain.getAttribute("includeSubdomains"));
            hosts.add(domain.getTextContent().trim());
        }
        assertEquals(new HashSet<>(Arrays.asList("10.0.2.2", "localhost")), hosts);
        NodeList all = root.getElementsByTagName("certificates");
        for (int i = 0; i < all.getLength(); i++) {
            assertFalse("user trust anchors are not allowed",
                    "user".equals(((Element) all.item(i)).getAttribute("src")));
        }
    }

    // ---- backup / extraction rules -----------------------------------------------------

    @Test
    public void dataExtractionRules_excludeEverythingForCloudBackupAndDeviceTransfer() throws Exception {
        Element root = parse("src/main/res/xml/data_extraction_rules.xml").getDocumentElement();
        assertEquals("data-extraction-rules", root.getNodeName());
        assertExcludesEverything(only(root, "cloud-backup"));
        assertExcludesEverything(only(root, "device-transfer"));
    }

    @Test
    public void backupRules_excludeEveryDomain() throws Exception {
        Element root = parse("src/main/res/xml/backup_rules.xml").getDocumentElement();
        assertEquals("full-backup-content", root.getNodeName());
        assertExcludesEverything(root);
    }

    // ---- FileProvider paths ------------------------------------------------------------

    @Test
    public void filePaths_containOnlyCachePath() throws Exception {
        Element root = parse("src/main/res/xml/file_paths.xml").getDocumentElement();
        assertEquals("paths", root.getNodeName());
        int elements = 0;
        NodeList nodes = root.getChildNodes();
        for (int i = 0; i < nodes.getLength(); i++) {
            if (nodes.item(i) instanceof Element) {
                elements++;
                assertEquals("cache-path", nodes.item(i).getNodeName());
            }
        }
        assertTrue("file_paths.xml must declare at least one cache-path", elements >= 1);
        assertEquals(0, root.getElementsByTagName("external-path").getLength());
        assertEquals(0, root.getElementsByTagName("external-files-path").getLength());
        assertEquals(0, root.getElementsByTagName("external-cache-path").getLength());
        assertEquals(0, root.getElementsByTagName("external-media-path").getLength());
    }
}
