# Export an Autopilot workspace

Autopilot keeps each user's workspace, including memories and sessions, in their OneDrive. This tool downloads a private copy of an Autopilot workspace to a Windows PC. Nothing in OneDrive is changed, shared or deleted.

## Download a copy of your own workspace

You need a Windows PC. The tool uses Windows PowerShell, which is included with Windows, and Git, which it offers to install.

1. Download [Autopilot-Workspace-Export.zip](./Autopilot-Workspace-Export.zip). Right-click it, choose **Extract All**, and open the extracted `Autopilot-Workspace-Export` folder. Do not run the tool from inside the zip file.
2. Double-click `Export-AutopilotWorkspace.cmd`.
3. If Git is missing, type `Y` to install Git for Windows with Windows Package Manager, then follow its prompts.
4. Press Enter to continue, and choose **Yes** when Windows asks for administrator approval.
5. Microsoft Edge opens the Microsoft sign-in page. Choose your own work account. Do not use another person's account.
6. When the browser says you are signed in, return to the PowerShell window. Choose **Yes** at the second administrator prompt.
7. If more than one Autopilot workspace is found, type the number of the one to download.
8. When the download finishes, File Explorer opens the new folder.

The folder is named `Autopilot export <date time>` in your user profile and contains:

- `Latest files`: a readable copy of the files in the latest version, such as memories and session records.
- `repository.git`: the full workspace history, including earlier versions, in Git format.
- `README.txt`: a short description of the copy.
- `export-manifest.json`: a record of the export, with a fingerprint (SHA-256 hash) of every file.

The administrator approvals let the tool prepare sign-in on this PC temporarily. The second approval removes those changes as soon as sign-in finishes.

## Export a user's workspace (administrators)

A tenant administrator can export another user's Autopilot workspace for an approved compliance or privacy request. The administrator signs in with their own account; the tool never uses the user's credentials.

1. Grant yourself temporary access to the user's OneDrive in the Microsoft 365 admin center:
   1. Go to [admin.microsoft.com](https://admin.microsoft.com) and sign in with your administrator account. An InPrivate window keeps this separate from your normal work account.
   2. Select **Users** > **Active users**, then select the user's name.
   3. On the user's page, select the **OneDrive** tab.
   4. Under **Get access to files**, select **Create link to files**.
   5. Copy the link that appears, for example `https://contoso-my.sharepoint.com/personal/user_contoso_com`. This is the user's OneDrive address.

   This makes you an administrator of that user's OneDrive until you remove the access. The grant is recorded in the audit log. It can take a few minutes to take effect.
2. Open PowerShell in the extracted `Autopilot-Workspace-Export` folder and run this, using the link from step 1 as `-TargetOneDriveUrl`:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Export-AutopilotWorkspace.ps1 -TargetUser user@contoso.com -Reason "Privacy request 1234" -Account admin@contoso.com -TargetOneDriveUrl "https://contoso-my.sharepoint.com/personal/user_contoso_com"
   ```

   `-TargetOneDriveUrl` is optional; without it the tool tries to find the user's OneDrive automatically.
3. Sign in with your administrator account, which `-Account` preselects. Your Windows account does not matter; only the browser sign-in identifies you as the administrator. If Edge signs you in automatically with a different account, copy the sign-in address that the tool prints into an InPrivate window (Ctrl+Shift+N). The tool finds the user's OneDrive and confirms that its owner matches `-TargetUser`. It then shows the workspace found and asks you to type the user's sign-in name to confirm.
4. When the export finishes, remove your access. The tool prints a `Set-SPOUser ... -IsSiteCollectionAdmin $false` command for this, or you can use the SharePoint admin center.

The export's `export-manifest.json` records who exported the data, for whom, when and why, with a fingerprint of every file. The tool prints the manifest's own SHA-256 hash at the end; record it with the request.

## If something goes wrong

| Message | What to do |
|---|---|
| Administrator approval was declined | Run the tool again and choose Yes, or ask IT support to run it with you. |
| Hosts file already has a different entry | Ask IT support to review the existing `cowork.local.microsoft.com` entry. |
| Browser shows a certificate warning | Do not bypass it. Close the tab and report it to IT support. |
| Your organization has not approved this sign-in | Ask IT support; the sign-in application may need consent in your organization. |
| Could not connect after 3 attempts | Check your network, VPN or proxy connection, then run the tool again. |
| No Autopilot workspace was found | Your workspace may be stored elsewhere. Ask your support team. |
| Some branch or tag references could not be downloaded | The copy is incomplete. Run the tool again into a new folder. |
| Temporary setup could not be removed automatically | Send the warning text to IT support. It names the hosts file line and certificate to remove. |
| You do not have access to the OneDrive of a user (administrators) | Complete step 1 of the administrator steps, wait a few minutes, then run the tool again with `-TargetOneDriveUrl`. |

To see more detail, open PowerShell in the tool's folder and run `.\Export-AutopilotWorkspace.ps1 -Verbose`. Use `-OutputFolder` to choose a different new folder; it must not be synchronized by OneDrive.

If PowerShell reports that running scripts is disabled, use `Export-AutopilotWorkspace.cmd` or the `powershell -ExecutionPolicy Bypass -File` form shown above. If your organization blocks PowerShell entirely, ask IT support.
