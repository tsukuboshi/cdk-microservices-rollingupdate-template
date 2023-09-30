import { RemovalPolicy, ScopedAws, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecrdeploy from "cdk-ecr-deployment";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";
import * as s3 from "aws-cdk-lib/aws-s3";

export class CdkMicroservicesRollingupdateTemplateStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Get AWS Account ID and Region
    const { accountId, region } = new ScopedAws(this);

    // Set Resource Name
    const resourceName = "test";

    // Create ECR Repository
    const ecrRepository = new ecr.Repository(this, "EcrRepo", {
      repositoryName: `${resourceName}-ecr-repo`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteImages: true,
    });

    // Create Docker Image Asset
    const dockerImageAsset = new DockerImageAsset(this, "DockerImageAsset", {
      directory: path.join(__dirname, "..", "app"),
      platform: Platform.LINUX_AMD64,
    });

    // Deploy Docker Image to ECR Repository
    new ecrdeploy.ECRDeployment(this, "DeployDockerImage", {
      src: new ecrdeploy.DockerImageName(dockerImageAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(
        `${accountId}.dkr.ecr.${region}.amazonaws.com/${ecrRepository.repositoryName}:latest`
      ),
    });

    // Create VPC and Subnet
    const vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `${resourceName}-vpc`,
      maxAzs: 2,
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/20"),
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: `${resourceName}-public`,
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Create ECS Cluster
    const cluster = new ecs.Cluster(this, "EcsCluster", {
      clusterName: `${resourceName}-cluster`,
      vpc: vpc,
    });

    // Create CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/ecs/${resourceName}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create ALB and ECS Fargate Service
    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "FargateService",
      {
        loadBalancerName: `${resourceName}-lb`,
        publicLoadBalancer: true,
        cluster: cluster,
        serviceName: `${resourceName}-service`,
        cpu: 256,
        desiredCount: 2,
        memoryLimitMiB: 512,
        assignPublicIp: true,
        taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        taskImageOptions: {
          family: `${resourceName}-taskdef`,
          containerName: `${resourceName}-container`,
          image: ecs.ContainerImage.fromEcrRepository(ecrRepository, "latest"),
          logDriver: new ecs.AwsLogDriver({
            streamPrefix: `container`,
            logGroup: logGroup,
          }),
        },
        deploymentController: {
          type: ecs.DeploymentControllerType.ECS,
        },
      }
    );

    // Create CodeCommit Repository
    const codeCommitRepository = new codecommit.Repository(
      this,
      "CodeCommitRepo",
      {
        repositoryName: `${resourceName}-codecommit-repo`,
        // code: codecommit.Code.fromDirectory(
        //   path.join(__dirname, "..", "app"),
        //   "main"
        // ),
      }
    );

    // Create CloudWatch Log Group
    const buildLogGroup = new logs.LogGroup(this, "BuildLogGroup", {
      logGroupName: `/aws/codebuild/${resourceName}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create CodeBuild Project
    const codeBuildProject = new codebuild.Project(this, "CodeBuildProject", {
      projectName: `${resourceName}-codebuild-project`,
      source: codebuild.Source.codeCommit({
        repository: codeCommitRepository,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
        environmentVariables: {
          AWS_ACCOUNT_ID: {
            value: accountId,
          },
          REPOSITORY_URI: {
            value: ecrRepository.repositoryUri,
          },
          CONTAINER_BUILD_PATH: {
            value: ".",
          },
          CONTAINER_NAME: {
            value: service.taskDefinition.defaultContainer?.containerName,
          },
        },
      },
      logging: {
        cloudWatch: {
          logGroup: buildLogGroup,
        },
      },
      // buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspec.yml"),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              "echo Logging in to Amazon ECR...",
              "aws --version",
              "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com",
              "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
              "IMAGE_TAG=${COMMIT_HASH:=latest}",
            ],
          },
          build: {
            commands: [
              "echo Build started on `date`",
              "echo Building the Docker image...",
              "docker build -t $REPOSITORY_URI:latest $CONTAINER_BUILD_PATH",
              "docker tag $REPOSITORY_URI:latest $REPOSITORY_URI:$IMAGE_TAG",
            ],
          },
          post_build: {
            commands: [
              "echo Build completed on `date`",
              "echo Pushing the Docker images...",
              "docker push $REPOSITORY_URI:$IMAGE_TAG",
              "docker push $REPOSITORY_URI:latest",
              "echo Writing image definitions file...",
              'printf \'[{"name":"%s","imageUri":"%s"}]\' $CONTAINER_NAME $REPOSITORY_URI:$IMAGE_TAG > imagedefinitions.json',
            ],
          },
        },
        artifacts: {
          files: ["imagedefinitions.json"],
        },
      }),
    });

    // Create ECR Access Policy
    const ecrAccessPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:GetAuthorizationToken",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
      ],
      resources: ["*"],
    });

    // Add ECR Access Policy to CodeBuild Project
    codeBuildProject.addToRolePolicy(ecrAccessPolicy);

    // Create Artifact Bucket for CodePipeline
    const artifactBucket = new s3.Bucket(this, "ArtifactBucket", {
      bucketName: `${resourceName}-artifact-bucket-${accountId}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Create CodePipeline
    const pipeline = new codepipeline.Pipeline(this, "CodePipeline", {
      artifactBucket: artifactBucket,
      pipelineName: `${resourceName}-pipeline`,
    });

    // Add Source Stage to Pipeline
    const sourceOutput = new codepipeline.Artifact(`${resourceName}-source`);
    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: "Source",
      repository: codeCommitRepository,
      output: sourceOutput,
      branch: "main",
      trigger: codepipeline_actions.CodeCommitTrigger.EVENTS,
    });
    pipeline.addStage({
      stageName: "Source",
      actions: [sourceAction],
    });

    // Add Build Stage to Pipeline
    const buildOutput = new codepipeline.Artifact(`${resourceName}-build`);
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "Build",
      project: codeBuildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });
    pipeline.addStage({
      stageName: "Build",
      actions: [buildAction],
    });

    // Add Deploy Stage to Pipeline
    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: "Deploy",
      service: service.service,
      imageFile: buildOutput.atPath("imagedefinitions.json"),
    });
    pipeline.addStage({
      stageName: "Deploy",
      actions: [deployAction],
    });
  }
}
