import {Args, Flags} from '@oclif/core';
import {SleekCommand} from "../sleek-command.js";
import ChartValidatorService from "../services/validate.js";
import HelmManagerService from "../services/helm.js";
import fs from "node:fs";
import SchemaValidationService from "../services/schemaValidation.js";
import {AddonData, AllEksSupportedKubernetesVersions, IssueData} from "../types/issue.js";
import {
  getChartNameFromUrl,
  getProtocolFromFullQualifiedUrl,
  getRepoFromFullChartUri,
  getVersionTagFromChartUri
} from "../utils.js";
import ValidateOpt from "../commandOpts/validate.js";

export default class Validate extends SleekCommand {
  static description = ValidateOpt.description;
  static summary = ValidateOpt.summary;
  static examples = ValidateOpt.examples;
  static args = ValidateOpt.args;
  static flags = ValidateOpt.flags;

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(Validate);

    // if helmURL is given, download the chart then validate
    // if file is given, validate based on the path
    // else, raise error stating one or the other arg/flag should be provided
    let repoProtocol, repoUrl, chartName, versionTag, addonName;
    let skipHooksValidation = flags.skipHooks;
    let skipReleaseService = flags.skipReleaseService;
    let addonData: AddonData | undefined = undefined;

    // uncomment for debugging purposes
    this.log('---')
    this.log(`>> args: ${JSON.stringify(args)}`)
    this.log(`>> flags: ${JSON.stringify(flags)}`)
    this.log('---')
    if (flags.addonName) {
      addonName = flags.addonName;
    }

    if (args.helmUrl || flags.helmUrl) {
      // JD decompose url, pull  and validate
      const repoUrlInput = args.helmUrl || flags.helmUrl;

      this.log(`Validating chart from url: ${repoUrlInput}`)
      repoProtocol = getProtocolFromFullQualifiedUrl(repoUrlInput!);
      repoUrl = getRepoFromFullChartUri(repoUrlInput!).substring(repoProtocol.length + 3); // 3 == '://'.length

      chartName = getChartNameFromUrl(repoUrl);
      versionTag = getVersionTagFromChartUri(repoUrlInput!);
    } else if (
      (args.helmUrl || flags.helmUrl) && (flags.helmRepo || flags.protocol || flags.version) // base url + flags to override // todo
    ) {
      const repoUrlInput = args.helmUrl || flags.helmUrl;

      repoProtocol = flags.protocol || getProtocolFromFullQualifiedUrl(repoUrlInput!);
      repoUrl = flags.helmRepo || getRepoFromFullChartUri(repoUrlInput!).substring(repoProtocol.length + 3);
      versionTag = flags.version || getVersionTagFromChartUri(repoUrlInput!);
    } else if (
      flags.helmRepo && flags.protocol && flags.version // all the url bits
    ) {
      repoProtocol = flags.protocol;
      repoUrl = flags.helmRepo;
      chartName = getChartNameFromUrl(repoUrl!);
      versionTag = flags.version;
      this.log(`Validating chart from flags: ${repoProtocol}://${repoUrl}:${versionTag}`)
    } else if (flags.file) {
      const filePath = flags.file;
      this.log(`Validating chart from input file ${filePath}`)
      // schema validation
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const schemaValidator = new SchemaValidationService(this);
      const data = await schemaValidator.validateInputFileSchema(fileContents);
      // get url
      const inputDataParsed = data.body as IssueData;
      addonData = inputDataParsed.addon;
      repoProtocol = addonData.helmChartUrlProtocol;
      repoUrl = getRepoFromFullChartUri(addonData.helmChartUrl);
      chartName = getChartNameFromUrl(repoUrl);
      versionTag = getVersionTagFromChartUri(addonData.helmChartUrl);
      addonName = inputDataParsed.addon.name;
      skipHooksValidation = inputDataParsed.chartAutoCorrection?.hooks;
      skipReleaseService = inputDataParsed.chartAutoCorrection?.releaseService;
    } else if (flags.directory) {
      this.log(`Validating chart from input directory ${flags.directory}`)
    } else {
      this.error("Either a Helm URL or a file path should be provided");
    }

    const helmManager = new HelmManagerService(this);
    const chartPath = !!flags.directory ?
      flags.directory :
      `${await helmManager.pullAndUnzipChart(repoUrl!, repoProtocol!, versionTag!, addonName)}/${chartName}`;

    // addonData is initialized when reading from the input yaml; when using flags the parameters are inferred
    if (!addonData) {
      addonData = {
        helmChartUrl: `${repoProtocol}://${repoUrl}:${versionTag}`,
        helmChartUrlProtocol: repoProtocol!,
        kubernetesVersion: flags.k8sVersions?.split(',') || AllEksSupportedKubernetesVersions,
        name: addonName!,
        namespace: flags.addonNamespace || 'test-namespace',
        version: versionTag!
      }
    }
    const validatorService = new ChartValidatorService(this, chartPath, addonData!);
    const validatorServiceResp = await validatorService.validate({skipHooksValidation, skipReleaseService});

    this.log(validatorServiceResp.body);
    if (!validatorServiceResp.success) {
      this.error(validatorServiceResp.error?.input!, validatorServiceResp.error?.options)
    }

    if (flags.extended) {
      const extendedValidatorServiceResp = await validatorService.extendedValidation(flags.file);
      this.log(extendedValidatorServiceResp.body);
      if (!extendedValidatorServiceResp.success) {
        this.error(extendedValidatorServiceResp.error?.input!, extendedValidatorServiceResp.error?.options)
      }
    }
  }
}
