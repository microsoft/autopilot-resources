# Microsoft Scout Resources

Resources for Microsoft Scout admins and users.

This repository doesn't contain the official Scout documentation; instead it's meant to be a place for supplementary resources: scripts, templates, tricks, tips, and other materials that are useful to Scout administrators and users.

## admins/

Policy templates for managing Scout in enterprise environments via Windows Group Policy or Microsoft Intune.

| File | Description |
| --- | --- |
| `microsoft-scout.admx` | Windows Administrative Template (ADMX) defining available Group Policy settings for Scout |
| `en-US/microsoft-scout.adml` | English language resource file required alongside the ADMX template |
| `microsoft-scout.mobileconfig` | macOS configuration profile for deploying Scout settings via Intune |

For instructions on importing and applying these templates, see [Set up Microsoft Scout with Intune](https://learn.microsoft.com/microsoft-scout/admin-intune-setup) and [Manage admin controls in Intune for Microsoft Scout](https://learn.microsoft.com/microsoft-scout/manage-group-policy).
